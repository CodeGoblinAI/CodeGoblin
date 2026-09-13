import { describe, expect, test } from "bun:test"
import {
  Permissions,
  commandOf,
  runsInlineCode,
  scopesOf,
  segmentsOf,
  type Rules,
} from "../src/core/permission"

/** The rules in Shawn's codegoblin.jsonc, as written there. */
const SHAWN: Rules = {
  "*rm -rf*": "deny",
  "*rm --recursive*": "deny",
  "*rmdir*": "deny",
  "*rd /s*": "deny",
  "*del *": "deny",
  "*erase *": "deny",
  "*Remove-Item*": "deny",
  "*rimraf*": "deny",
}

const shell = (command: string) => JSON.stringify({ command })

function counting(answer: "once" | "always" | "reject", rules: Rules = {}) {
  let asked = 0
  const permissions = new Permissions(
    async () => {
      asked++
      return answer
    },
    () => rules,
  )
  return { permissions, asked: () => asked }
}

describe("a deny rule", () => {
  test("refuses in full access, without asking, and names the rule", async () => {
    const { permissions, asked } = counting("always", SHAWN)
    permissions.mode = "full"
    // Harmless if the guard ever failed: it only prints the words.
    const verdict = await permissions.decide("shell", shell("echo rm -rf nothing"))
    expect(verdict.allowed).toBe(false)
    expect(!verdict.allowed && verdict.reason).toContain('"*rm -rf*"')
    expect(asked()).toBe(0)
  })

  test("beats an approval given earlier in the session", async () => {
    const { permissions } = counting("always", { "*rd /s*": "deny" })
    expect(await permissions.check("shell", shell("rd /q build"))).toBe(true)
    expect(await permissions.check("shell", shell("rd /s /q build"))).toBe(false)
  })

  test("beats planning's reason with its own, since it is the more specific one", async () => {
    const { permissions } = counting("always", SHAWN)
    permissions.planning = true
    const verdict = await permissions.decide("shell", shell("rm -rf x"))
    expect(!verdict.allowed && verdict.reason).toContain("codegoblin.jsonc")
  })

  test("catches the command wherever it sits in a chain", async () => {
    const { permissions } = counting("always", SHAWN)
    permissions.mode = "full"
    expect(await permissions.check("shell", shell("git status & rd /s /q dist"))).toBe(false)
    expect(await permissions.check("shell", shell("bun test && Remove-Item -Recurse out"))).toBe(false)
  })

  test("every one of the eight rules blocks what it names", async () => {
    const { permissions } = counting("always", SHAWN)
    permissions.mode = "full"
    const commands = ["rm -rf x", "rm --recursive x", "rmdir x", "rd /s x", "del x.txt", "erase x.txt", "Remove-Item x", "npx rimraf x"]
    for (const command of commands) {
      expect([command, await permissions.check("shell", shell(command))]).toEqual([command, false])
    }
  })

  test.skipIf(process.platform !== "win32")("on Windows a lower-case remove-item is still caught", async () => {
    const { permissions } = counting("always", SHAWN)
    permissions.mode = "full"
    expect(await permissions.check("shell", shell("powershell -c remove-item -recurse x"))).toBe(false)
  })

  test("reads the rules fresh, so one added mid-session applies to the next call", async () => {
    let rules: Rules = {}
    const permissions = new Permissions(async () => "once", () => rules)
    permissions.mode = "full"
    expect(await permissions.check("shell", shell("rimraf dist"))).toBe(true)
    rules = { "*rimraf*": "deny" }
    expect(await permissions.check("shell", shell("rimraf dist"))).toBe(false)
  })

  test("only governs shell - a file named like a command is still a file", async () => {
    const { permissions } = counting("always", SHAWN)
    permissions.mode = "full"
    expect(await permissions.check("write_file", JSON.stringify({ path: "notes/rm -rf.md", content: "" }))).toBe(true)
  })

  test("a plain-text detail is matched as the command itself", async () => {
    const { permissions } = counting("always", SHAWN)
    permissions.mode = "full"
    expect(await permissions.check("shell", "rm -rf /")).toBe(false)
  })

  test("it matches text, so *del * also stops an innocent --model", async () => {
    // Recorded, not endorsed: this is what the rule does as written, because
    // "model " contains "del ".
    const { permissions } = counting("always", SHAWN)
    permissions.mode = "full"
    expect(await permissions.check("shell", shell("bun src/cli/prompt.ts --model deepseek/deepseek-v4-flash hi"))).toBe(false)
  })
})

describe("an ask rule", () => {
  test("asks even in full access", async () => {
    const { permissions, asked } = counting("once", { "git push*": "ask" })
    permissions.mode = "full"
    expect(await permissions.check("shell", shell("git push origin main"))).toBe(true)
    expect(asked()).toBe(1)
  })

  test("asks again even after an approval for the session", async () => {
    const { permissions, asked } = counting("always", { "git push*": "ask" })
    await permissions.check("shell", shell("git push origin main"))
    await permissions.check("shell", shell("git push origin main"))
    expect(asked()).toBe(2)
  })
})

describe("an allow rule", () => {
  test("never skips consent - it only means the rules do not block the command", async () => {
    const { permissions, asked } = counting("once", { "git *": "allow" })
    expect(await permissions.check("shell", shell("git status"))).toBe(true)
    expect(asked()).toBe(1)
  })

  test("can carve an exception out of a broader deny", async () => {
    const { permissions } = counting("once", { "*": "deny", "git status*": "allow" })
    expect(await permissions.check("shell", shell("git status"))).toBe(true)
    expect(await permissions.check("shell", shell("ls"))).toBe(false)
  })
})

describe("what one shell approval covers", () => {
  test("approving git status does not approve git push", async () => {
    const answers = ["always", "reject"]
    let index = 0
    const permissions = new Permissions(async () => answers[index++] as never)
    expect(await permissions.check("shell", shell("git status"))).toBe(true)
    expect(await permissions.check("shell", shell("git status --short"))).toBe(true)
    expect(await permissions.check("shell", shell("git push --force"))).toBe(false)
    expect(index).toBe(2)
  })

  test("inline code is approved exactly, never as the whole interpreter", async () => {
    let asked = 0
    const permissions = new Permissions(async () => {
      asked++
      return "always"
    })
    await permissions.check("shell", shell(`node -e "console.log(1)"`))
    await permissions.check("shell", shell(`node -e "console.log(1)"`))
    await permissions.check("shell", shell(`node -e "require('fs').rmSync('x')"`))
    expect(asked).toBe(2)
  })

  test("one script is not every script", async () => {
    let asked = 0
    const permissions = new Permissions(async () => {
      asked++
      return "always"
    })
    await permissions.check("shell", shell("node build.js"))
    await permissions.check("shell", shell("node wipe.js"))
    expect(asked).toBe(2)
  })

  test("a chain asks unless every command in it was approved", async () => {
    let asked = 0
    const permissions = new Permissions(async () => {
      asked++
      return "always"
    })
    await permissions.check("shell", shell("bun test"))
    await permissions.check("shell", shell("git status"))
    await permissions.check("shell", shell("bun test && git status"))
    await permissions.check("shell", shell("bun test && curl example.com"))
    expect(asked).toBe(3)
  })

  test("cmd /c counts as inline code, whatever its case", () => {
    expect(runsInlineCode(["cmd", "/c", "rd", "/s", "x"])).toBe(true)
    expect(runsInlineCode(["cmd.exe", "/C", "dir"])).toBe(true)
  })

  test("an interpreter is recognised by its full path and in any case", () => {
    expect(runsInlineCode(["C:/Program Files/nodejs/NODE.EXE", "-e", "1"])).toBe(true)
    expect(runsInlineCode(["powershell", "-Command", "Get-Date"])).toBe(true)
  })

  test("an ordinary command that takes -c is not inline code", () => {
    expect(runsInlineCode(["git", "-c", "user.name=x", "commit"])).toBe(false)
    expect(runsInlineCode(["python", "script.py"])).toBe(false)
  })
})

describe("reading a shell call", () => {
  test("an operator inside quotes stays part of the argument", () => {
    expect(segmentsOf(`git commit -m "fix a & b"`)).toEqual([`git commit -m "fix a & b"`])
  })

  test("&& and || are one break each, and a redirect is not a break at all", () => {
    expect(segmentsOf("a && b || c")).toEqual(["a", "b", "c"])
    expect(segmentsOf("bun test 2>&1 | more")).toEqual(["bun test 2>&1", "more"])
  })

  test("the command comes from the tool's JSON arguments, or is the text itself", () => {
    expect(commandOf(JSON.stringify({ command: "ls -la" }))).toBe("ls -la")
    expect(commandOf("ls -la")).toBe("ls -la")
  })

  test("an empty shell call is scoped to the tool, as it always was", () => {
    expect(scopesOf("shell", "")).toEqual(["shell"])
  })

  test("the summary says what was approved, in words", async () => {
    const permissions = new Permissions(async () => "always")
    await permissions.check("shell", shell("git status"))
    await permissions.check("shell", shell("npm run dev"))
    expect(permissions.summary()).toEqual(["shell:git status", "shell:npm run dev"])
  })
})

describe("a refusal says why", () => {
  test("planning says planning", async () => {
    const permissions = new Permissions(async () => "always")
    permissions.planning = true
    const verdict = await permissions.decide("write_file", "{}")
    expect(!verdict.allowed && verdict.reason).toContain("planning is on")
    expect(!verdict.allowed && verdict.by).toBe("plan")
  })

  test("a rejection says the user refused", async () => {
    const permissions = new Permissions(async () => "reject")
    const verdict = await permissions.decide("write_file", "{}")
    expect(!verdict.allowed && verdict.reason).toBe("refused by the user")
    expect(!verdict.allowed && verdict.by).toBe("user")
  })

  test("a rule block names the rule, so a surface can too", async () => {
    const permissions = new Permissions(async () => "always", () => ({ "*rm -rf*": "deny" }))
    const verdict = await permissions.decide("shell", shell("echo rm -rf nothing"))
    expect(verdict).toMatchObject({ allowed: false, by: "rule", rule: "*rm -rf*" })
  })
})

describe("what a refused call is labelled", () => {
  // Both surfaces said "refused" for everything, so a command a rule stopped
  // read as one the person had turned down.
  test("each kind of refusal says whose decision it was", async () => {
    const { refusalLabel } = await import("../src/core/permission")
    expect(refusalLabel({ by: "rule", rule: "*rm -rf*" })).toBe('blocked by "*rm -rf*"')
    expect(refusalLabel({ by: "plan" })).toBe("not run while planning")
    expect(refusalLabel({ by: "user" })).toBe("refused")
  })

  test("a refusal that says nothing about itself is still labelled", async () => {
    const { refusalLabel } = await import("../src/core/permission")
    expect(refusalLabel({})).toBe("refused")
    expect(refusalLabel({ by: "rule" })).toBe("blocked by a rule")
  })
})

describe("what an approval for this session covers, in words", () => {
  // The hint said "calls like this", which meant nothing once an approval
  // covered one command instead of the whole tool.
  test("a shell approval names the words of the command it covers", async () => {
    const { coverOf } = await import("../src/core/permission")
    expect(coverOf("shell", shell("git status --short"))).toBe('"git status"')
    expect(coverOf("shell", shell("npm run dev -- --port 3000"))).toBe('"npm run dev"')
  })

  test("a chain names each command once", async () => {
    const { coverOf } = await import("../src/core/permission")
    expect(coverOf("shell", shell("git add . && git commit -m wip && git add -A"))).toBe('"git add" and "git commit"')
  })

  test("inline code says it is covered exactly, rather than naming the interpreter", async () => {
    const { coverOf } = await import("../src/core/permission")
    expect(coverOf("shell", shell('node -e "console.log(1)"'))).toBe("this exact node command")
  })

  test("a fetch names the host, and any other tool is named whole", async () => {
    const { coverOf } = await import("../src/core/permission")
    expect(coverOf("webfetch", JSON.stringify({ url: "https://github.com/anthropics" }))).toBe("github.com")
    expect(coverOf("write_file", JSON.stringify({ path: "a.ts" }))).toBe("every write_file call")
  })

  test("the person asked is told exactly that", async () => {
    const heard: string[] = []
    const permissions = new Permissions(async (_tool, _detail, cover) => {
      heard.push(cover)
      return "once"
    })
    await permissions.decide("shell", shell("git log -1 --oneline"))
    expect(heard).toEqual(['"git log"'])
  })
})
