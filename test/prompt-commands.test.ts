import { expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { customCommands, invocationItems, resolveInvocation } from "../src/core/invocations"
import { PROMPT_COMMANDS } from "../src/core/prompt-commands"
import { runCommand } from "../src/core/commands"

const project = () => fs.mkdtempSync(path.join(process.env.CODEGOBLIN_TEST_SANDBOX!, "prompt-commands-"))

test("the six shipped prompts are commands, expanded with what was typed", () => {
  const cwd = project()
  // All six are commands. A file of the same name replaces one (another test file leaves a /review in the
  // shared profile, and which file runs first differs by system), so only the names are fixed, not who owns them.
  const commands = customCommands(cwd)
  const shipped = ["goal", "grill", "init", "review", "teach", "verify"]
  expect(PROMPT_COMMANDS.map((command) => command.name).sort()).toEqual(shipped)
  for (const name of shipped) expect(commands.map((command) => command.name)).toContain(name)
  for (const command of commands.filter((each) => each.scope === "built-in")) expect(shipped).toContain(command.name)
  const goal = resolveInvocation("/goal make the tests pass on Windows", cwd)!
  expect(goal.kind).toBe("command")
  expect(goal.content).toContain("You are in GOAL mode")
  expect(goal.content).toContain("make the tests pass on Windows")
  const review = resolveInvocation("/review 3f6b5d3", cwd)!
  expect(review.content).toContain("What to review: 3f6b5d3")
  expect(review.content).toContain("[Important]")
  expect(review.content).toContain("[Pre-existing]")
  expect(review.content).toContain("REVIEW.md")
  const verify = resolveInvocation("/verify encodings and undo", cwd)!
  expect(verify.content).toContain("encodings and undo")
  expect(verify.content).toContain("3 repair attempts")
  // Nothing typed still leaves a usable prompt: /review reviews uncommitted work.
  expect(resolveInvocation("/review", cwd)!.content).toContain("Nothing given: the uncommitted changes")
})

test("a project's own file of the same name replaces a shipped prompt", () => {
  const cwd = project()
  fs.mkdirSync(path.join(cwd, ".codegoblin", "commands"), { recursive: true })
  fs.writeFileSync(path.join(cwd, ".codegoblin", "commands", "review.md"), "---\ndescription: team review\n---\nOUR_REVIEW $ARGUMENTS")
  const review = customCommands(cwd).find((command) => command.name === "review")!
  expect(review.scope).toBe("project")
  expect(resolveInvocation("/review main", cwd)!.content).toBe("OUR_REVIEW main")
})

test("listed in the pickers, and none shadows or is shadowed by a built-in command", () => {
  const cwd = project()
  const listed = invocationItems(cwd).map((item) => item.value)
  for (const prompt of PROMPT_COMMANDS) {
    expect(listed).toContain("/" + prompt.name)
    const result = runCommand("/" + prompt.name)
    expect(result.kind === "message" && result.text.startsWith("unknown command")).toBe(true)
    expect(prompt.template).toContain("$ARGUMENTS")
  }
})

test("questions are asked in one message and then the turn ends: there is no question tool", () => {
  for (const name of ["grill", "teach"]) {
    const template = PROMPT_COMMANDS.find((prompt) => prompt.name === name)!.template
    expect(template).not.toContain("`question` tool")
    expect(template).toMatch(/end your turn/i)
  }
})
