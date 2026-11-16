import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { Global } from "../src/platform/paths"
import { parseFrontmatter } from "../src/core/frontmatter"
import { listSkills, runSkillTool, skillIndex } from "../src/core/skills"
import { customCommands, expandTemplate, invocationItems, resolveInvocation } from "../src/core/invocations"
import { requireSandbox } from "./sandbox"

// Everything here is written under the sandbox test/preload.ts made: the
// discovered home and config directories both live inside it.
const home = Global.Path.home
requireSandbox(path.join(home, ".claude", "skills", "probe"), "the skills tests")
requireSandbox(path.join(Global.Path.config, "skills", "probe"), "the skills tests")

const write = (file: string, text: string) => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
}
const claudeSkills = path.join(home, ".claude", "skills")
const configSkills = path.join(Global.Path.config, "skills")
let project = ""

beforeAll(() => {
  project = fs.mkdtempSync(path.join(home, "project-"))

  write(
    path.join(claudeSkills, "alpha", "SKILL.md"),
    ["---", "name: alpha", "description: >-", "  Does the alpha thing,", "  across two lines.", "argument-hint: '[target]'", "metadata:", "  surfaces:", "    - ide", "---", "", "# Alpha", "Step one.", ""].join("\r\n"),
  )
  write(path.join(claudeSkills, "alpha", "notes", "guide.md"), "the guide")
  write(path.join(claudeSkills, "alpha", "scripts", "run.sh"), "echo run")
  write(path.join(claudeSkills, "shared", "SKILL.md"), "---\nname: shared\ndescription: global version\n---\nglobal body")
  write(path.join(configSkills, "beta", "SKILL.md"), "---\nname: beta\ndescription: people only\ndisable-model-invocation: true\n---\nbeta body")
  write(path.join(configSkills, "hidden", "SKILL.md"), "---\nname: hidden\ndescription: the model only\nuser-invocable: false\n---\nhidden body")
  write(path.join(configSkills, "unnamed", "SKILL.md"), "---\ndescription: named after its folder\n---\nbody")
  write(path.join(configSkills, "help", "SKILL.md"), "---\nname: help\ndescription: tries to take over /help\n---\nno")
  write(path.join(configSkills, "review", "SKILL.md"), "---\nname: review\ndescription: loses to the command\n---\nskill review")
  write(path.join(project, ".claude", "skills", "shared", "SKILL.md"), "---\nname: shared\ndescription: project version\n---\nproject body")
  write(path.join(home, "outside.txt"), "not for skills")

  write(path.join(Global.Path.config, "commands", "review.md"), "---\ndescription: Review a file\nargument-hint: <file> <focus>\n---\nReview $1 carefully. Focus: $2")
  write(path.join(Global.Path.config, "command", "git", "commit.md"), "Commit with message: $ARGUMENTS")
  write(path.join(Global.Path.config, "commands", "plain.md"), "Tell a joke.")
  write(path.join(project, ".codegoblin", "commands", "plain.md"), "Tell a project joke.")
})

// The global commands go again: the profile is shared by every test file in a run, and a /review left here
// replaced the shipped one in whichever file happened to run next.
afterAll(() => {
  for (const file of [["commands", "review.md"], ["command", "git", "commit.md"], ["commands", "plain.md"]]) {
    fs.rmSync(path.join(Global.Path.config, ...file), { force: true })
  }
})

describe("reading frontmatter", () => {
  test("a folded description joins its lines, and CRLF files read the same", () => {
    const { data, body } = parseFrontmatter("---\r\nname: x\r\ndescription: >-\r\n  one\r\n  two\r\n---\r\nbody")
    expect(data).toEqual({ name: "x", description: "one two" })
    expect(body).toBe("body")
  })

  test("a literal block keeps its lines", () => {
    expect(parseFrontmatter("---\nnote: |\n  line one\n  line two\n---\n").data.note).toBe("line one\nline two")
  })

  test("quotes come off, booleans are booleans, nested blocks are skipped", () => {
    const { data } = parseFrontmatter(
      "---\nname: 'it''s'\ndescription: \"a \\\"quoted\\\" thing\"\nflag: true\nmetadata:\n  deep: value\nafter: kept\n---\n",
    )
    expect(data).toEqual({ name: "it's", description: 'a "quoted" thing', flag: true, after: "kept" })
  })

  test("a colon in an unquoted description is kept, as other tools allow", () => {
    expect(parseFrontmatter("---\ndescription: Use when: things happen\n---\n").data.description).toBe("Use when: things happen")
  })

  test("a file without frontmatter is all body", () => {
    expect(parseFrontmatter("# Just a heading")).toEqual({ data: {}, body: "# Just a heading" })
  })
})

describe("finding skills", () => {
  test("from the global folders, with the folder name standing in for a missing name", () => {
    const names = listSkills(project).map((skill) => skill.name)
    for (const name of ["alpha", "beta", "hidden", "unnamed", "shared"]) expect(names).toContain(name)
  })

  test("a project's own skill wins over a global one of the same name", () => {
    const shared = listSkills(project).find((skill) => skill.name === "shared")!
    expect(shared.description).toBe("project version")
    expect(shared.scope).toBe("project")
  })

  test("the index offers only what the model may start, and says to load before guessing", () => {
    const index = skillIndex(listSkills(project))!
    expect(index).toContain("- alpha: Does the alpha thing, across two lines.")
    expect(index).toContain("skill tool")
    expect(index).not.toContain("beta")
  })

  test("nothing to offer is no index at all", () => {
    expect(skillIndex([])).toBeUndefined()
  })
})

describe("the skill tool", () => {
  test("loads the instructions, and lists the files that come with them", () => {
    const result = runSkillTool("alpha", undefined, project)
    expect(result).toContain("# Skill: alpha")
    expect(result).toContain("Step one.")
    expect(result).toContain("- notes/guide.md")
    expect(result).toContain("- scripts/run.sh")
  })

  test("reads a file from inside the skill's folder", () => {
    expect(runSkillTool("alpha", "notes/guide.md", project)).toBe("the guide")
  })

  test("refuses anything outside it, whether or not the file exists", () => {
    // The skill is home/.claude/skills/alpha, so three levels up is the home, where outside.txt is.
    expect(runSkillTool("alpha", "../../../outside.txt", project)).toContain("outside the alpha skill's folder")
    // A missing file out there gets the same answer, so the tool cannot be used to see what exists.
    expect(runSkillTool("alpha", "../../../no-such-file.txt", project)).toContain("outside the alpha skill's folder")
    expect(runSkillTool("alpha", path.join(home, "outside.txt"), project)).toContain("outside the alpha skill's folder")
  })

  test("refuses a skill only a person may start, and names the ones it can", () => {
    expect(runSkillTool("beta", undefined, project)).toContain("only the user can start it")
    const missing = runSkillTool("nope", undefined, project)
    expect(missing).toContain('no skill named "nope"')
    expect(missing).toContain("alpha")
    expect(missing).not.toContain("beta")
  })
})

describe("custom commands", () => {
  test("are named by their path, with project ones winning", () => {
    const commands = customCommands(project)
    expect(commands.map((command) => command.name)).toEqual(expect.arrayContaining(["review", "git/commit", "plain"]))
    expect(commands.find((command) => command.name === "plain")!.template).toBe("Tell a project joke.")
  })

  test("numbered arguments take a word each, and the last takes the rest", () => {
    expect(expandTemplate("Review $1 carefully. Focus: $2", 'src/a.ts "error handling" and naming')).toBe(
      "Review src/a.ts carefully. Focus: error handling and naming",
    )
  })

  test("$ARGUMENTS is the whole line, and a missing argument is left empty", () => {
    expect(expandTemplate("Commit with message: $ARGUMENTS", "fix the thing")).toBe("Commit with message: fix the thing")
    expect(expandTemplate("A $1 and $2.", "only")).toBe("A only and .")
  })

  test("a template that asks for nothing still gets what was typed", () => {
    expect(expandTemplate("Tell a joke.", "about goblins")).toBe("Tell a joke.\n\nabout goblins")
    expect(expandTemplate("Tell a joke.", "")).toBe("Tell a joke.")
  })
})

describe("a typed slash line", () => {
  test("a custom command becomes its expanded template", () => {
    expect(resolveInvocation('/review src/a.ts "naming"', project)).toEqual({
      kind: "command",
      name: "review",
      args: 'src/a.ts "naming"',
      content: "Review src/a.ts carefully. Focus: naming",
    })
  })

  test("a skill becomes its instructions with the request after them", () => {
    const invoked = resolveInvocation("/alpha the login page", project)!
    expect(invoked.kind).toBe("skill")
    expect(invoked.content).toContain("# Skill: alpha")
    expect(invoked.content.endsWith("Request: the login page")).toBe(true)
  })

  test("a skill a person may start works even though the model may not", () => {
    expect(resolveInvocation("/beta", project)?.kind).toBe("skill")
  })

  test("built-ins always win, and a skill hidden from people is not a command", () => {
    expect(resolveInvocation("/help", project)).toBeUndefined()
    expect(resolveInvocation("/new", project)).toBeUndefined()
    expect(resolveInvocation("/hidden", project)).toBeUndefined()
    expect(resolveInvocation("hello", project)).toBeUndefined()
  })

  test("the picker lists commands and skills, never a built-in, and a name only once", () => {
    const values = invocationItems(project).map((item) => item.value)
    expect(values).toEqual(expect.arrayContaining(["/review", "/git/commit", "/alpha", "/beta"]))
    expect(values).not.toContain("/help")
    expect(values).not.toContain("/hidden")
    expect(values.filter((value) => value === "/review").length).toBe(1)
    expect(invocationItems(project).find((item) => item.value === "/alpha")!.hint).toContain("[target]")
  })
})
