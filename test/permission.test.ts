import { describe, expect, test } from "bun:test"
import { Permissions, DECISIONS, MODES, nextMode, scopeOf, decisionHints, askedFor, CHECKPOINT_TOOL } from "../src/core/permission"

describe("permissions", () => {
  test("tools that change nothing never prompt", async () => {
    let asked = 0
    const permissions = new Permissions(async () => { asked++; return "always" })
    for (const tool of ["read_file", "list_files", "grep", "glob", "todo_write"]) {
      expect(await permissions.check(tool, "")).toBe(true)
    }
    expect(asked).toBe(0)
  })

  // Asking on every write trains people to approve without reading, so
  // "always" exists - but it has to be chosen, never assumed.
  test("allow-for-the-session asks once and then remembers", async () => {
    let asked = 0
    const permissions = new Permissions(async () => { asked++; return "always" })
    await permissions.check("write_file", "a")
    await permissions.check("write_file", "b")
    await permissions.check("write_file", "c")
    expect(asked).toBe(1)
  })

  test("allow-once lets one call through and asks again", async () => {
    let asked = 0
    const permissions = new Permissions(async () => { asked++; return "once" })
    expect(await permissions.check("write_file", "a")).toBe(true)
    expect(await permissions.check("write_file", "b")).toBe(true)
    expect(asked).toBe(2)
  })

  test("a rejection refuses this call and nothing more", async () => {
    let asked = 0
    const permissions = new Permissions(async () => { asked++; return "reject" })
    expect(await permissions.check("shell", "rm -rf /")).toBe(false)
    expect(await permissions.check("shell", "ls")).toBe(false)
    // Asked twice: only "always" is sticky, so a refusal never silently
    // hardens into a standing rule the user did not ask for.
    expect(asked).toBe(2)
  })

  test("one allow-once never becomes a standing approval", async () => {
    const answers: string[] = ["once", "reject"]
    let index = 0
    const permissions = new Permissions(async () => answers[index++] as never)
    expect(await permissions.check("shell", "first")).toBe(true)
    expect(await permissions.check("shell", "second")).toBe(false)
  })

  test("different tools are approved separately", async () => {
    const seen: string[] = []
    const permissions = new Permissions(async (tool) => { seen.push(tool); return "always" })
    await permissions.check("write_file", "")
    await permissions.check("shell", "")
    expect(seen).toEqual(["write_file", "shell"])
  })

  test("a new conversation clears standing approvals", async () => {
    let asked = 0
    const permissions = new Permissions(async () => { asked++; return "always" })
    await permissions.check("shell", "")
    permissions.reset()
    await permissions.check("shell", "")
    expect(asked).toBe(2)
  })

  test("only what was granted shows up in the summary", async () => {
    const permissions = new Permissions(async (tool) => (tool === "shell" ? "always" : "once"))
    await permissions.check("shell", "")
    await permissions.check("write_file", "")
    expect(permissions.summary()).toEqual(["shell"])
  })
})

describe("the answers on offer", () => {
  test("there are three, and reject is one of them", () => {
    expect(DECISIONS.map((d) => d.id)).toEqual(["once", "always", "reject"])
  })

  test("the least committal one comes first", () => {
    expect(DECISIONS[0]!.id).toBe("once")
  })

  test("each has something a person can read", () => {
    for (const decision of DECISIONS) {
      expect([decision.id, decision.label.length > 0 && decision.hint.length > 0]).toEqual([decision.id, true])
    }
  })
})

describe("what one approval covers", () => {
  test("a host at a time for webfetch, so one yes is not every yes", () => {
    expect(scopeOf("webfetch", JSON.stringify({ url: "https://example.com/a" }))).toBe("webfetch:example.com")
    expect(scopeOf("webfetch", JSON.stringify({ url: "https://evil.test/x" }))).toBe("webfetch:evil.test")
  })

  test("approving one host for the session does not approve the next", async () => {
    const asked: string[] = []
    const permissions = new Permissions(async (_tool, detail) => {
      asked.push(detail)
      return detail.includes("example.com") ? "always" : "reject"
    })

    expect(await permissions.check("webfetch", JSON.stringify({ url: "https://example.com/1" }))).toBe(true)
    expect(await permissions.check("webfetch", JSON.stringify({ url: "https://example.com/2" }))).toBe(true)
    expect(await permissions.check("webfetch", JSON.stringify({ url: "https://evil.test/1" }))).toBe(false)

    expect(asked.length).toBe(2)
  })
})

describe("how much to ask", () => {
  test("ask is the default, and nothing is remembered until you say so", async () => {
    const permissions = new Permissions(async () => "once")
    expect(permissions.mode).toBe("ask")
  })

  test("full access approves without asking at all", async () => {
    let asked = 0
    const permissions = new Permissions(async () => { asked++; return "reject" })
    permissions.mode = "full"
    expect(await permissions.check("shell", JSON.stringify({ command: "ls" }))).toBe(true)
    expect(await permissions.check("write_file", JSON.stringify({ path: "a" }))).toBe(true)
    expect(asked).toBe(0)
  })

  test("approve for me lets edits and read-only commands through, and asks about the rest", async () => {
    const asked: string[] = []
    const permissions = new Permissions(async (tool) => { asked.push(tool); return "reject" })
    permissions.mode = "approve"
    const cmd = (command: string) => JSON.stringify({ command })
    expect(await permissions.check("write_file", JSON.stringify({ path: "a.ts" }))).toBe(true)
    expect(await permissions.check("edit_file", JSON.stringify({ path: "a.ts" }))).toBe(true)
    expect(await permissions.check("shell", cmd("git status --short"))).toBe(true)
    expect(await permissions.check("shell", cmd("ls && git log -1"))).toBe(true)
    expect(asked).toEqual([])

    const risky = ["npm test", "git push", "git branch -D main", "echo hi > out.txt", "rg --pre ./x foo", "git -c core.pager=evil log", 'node -e "1"']
    for (const command of risky) {
      expect([command, await permissions.check("shell", cmd(command))]).toEqual([command, false])
    }
    expect(await permissions.check("webfetch", JSON.stringify({ url: "https://example.com" }))).toBe(false)
    expect(await permissions.check("mcp__github__create_issue", "{}")).toBe(false)
    expect(asked.length).toBe(risky.length + 2)
  })

  test("planning refuses anything that changes something, without asking, whatever the mode", async () => {
    let asked = 0
    const permissions = new Permissions(async () => { asked++; return "always" })
    permissions.planning = true
    permissions.mode = "full"
    for (const tool of ["write_file", "edit_file", "mcp__github__create_issue"]) {
      expect([tool, await permissions.check(tool, "{}")]).toEqual([tool, false])
    }
    expect(await permissions.check("shell", JSON.stringify({ command: "npm install" }))).toBe(false)
    // The point is that nothing changes, not that you are asked whether it may.
    expect(asked).toBe(0)
  })

  test("planning still lets the model look: reading, searching, read-only commands, pages", async () => {
    const permissions = new Permissions(async () => "once")
    permissions.planning = true
    for (const tool of ["read_file", "list_files", "grep", "glob", "todo_write", "skill"]) {
      expect([tool, await permissions.check(tool, "{}")]).toEqual([tool, true])
    }
    expect(await permissions.check("shell", JSON.stringify({ command: "git log -5" }))).toBe(true)
    expect(await permissions.check("webfetch", JSON.stringify({ url: "https://example.com" }))).toBe(true)
  })

  test("the modes cycle, and come back round", () => {
    expect(MODES.map((m) => m.id)).toEqual(["ask", "approve", "full"])
    expect(nextMode("ask")).toBe("approve")
    expect(nextMode("approve")).toBe("full")
    expect(nextMode("full")).toBe("ask")
  })

  test("every mode says what it does", () => {
    for (const mode of MODES) {
      expect([mode.id, mode.label.length > 0 && mode.hint.length > 0]).toEqual([mode.id, true])
    }
  })

  test("autonomy checkpoints ask in words, and for-this-session turns them off", async () => {
    const seen: { tool: string; detail: string; cover: string }[] = []
    const permissions = new Permissions(async (tool, detail, cover) => {
      seen.push({ tool, detail, cover })
      return "once"
    })
    expect(await permissions.checkpoint(10, 10)).toBe("continue")
    expect(seen).toEqual([{ tool: "autonomous run", detail: "10 tool calls this turn - keep going", cover: "future checkpoints" }])
    expect(permissions.checkpointsOff).toBe(false)

    const refusing = new Permissions(async () => "reject")
    expect(await refusing.checkpoint(10, 10)).toBe("stop")

    const disabling = new Permissions(async () => "always")
    expect(await disabling.checkpoint(10, 10)).toBe("continue")
    expect(disabling.checkpointsOff).toBe(true)
    let asked = 0
    const off = new Permissions(async () => { asked++; return "once" })
    off.checkpointsOff = true
    expect(await off.checkpoint(99, 10)).toBe("continue")
    expect(asked).toBe(0)
    off.reset()
    expect(off.checkpointsOff).toBe(false)
  })

  test("a checkpoint's answers say what they do there, not what they do for a tool call", async () => {
    let tool = ""
    await new Permissions(async (asked) => { tool = asked; return "once" }).checkpoint(3, 3)
    expect(tool).toBe(CHECKPOINT_TOOL)
    const atCheckpoint = decisionHints(CHECKPOINT_TOOL, "future checkpoints")
    expect(atCheckpoint.once).toBe("keep going until the next checkpoint")
    expect(atCheckpoint.reject).toBe("stop the turn here")
    expect(Object.values(atCheckpoint).join(" ")).not.toContain("one call")
    const shell = decisionHints("shell", "git status")
    expect(shell).toEqual({ once: "just this one call", always: "stop asking about git status", reject: "refuse, and tell the model so" })
    expect(decisionHints("write_file").always).toBe("stop asking about calls like this")
  })

  test("an approval names the file first, so a narrow box cannot cut it off", () => {
    const edit = JSON.stringify({ new_string: "  return a + b", old_string: "  return a - b", path: "src/sum.js" })
    expect(askedFor("edit_file", edit)).toBe('src/sum.js: "return a - b" -> "return a + b"')
    const long = JSON.stringify({ path: "a.ts", old_string: "x".repeat(100), new_string: "y" })
    expect(askedFor("edit_file", long)).toMatch(/^a\.ts: "x{39}…" -> "y"$/)
    expect(askedFor("write_file", JSON.stringify({ path: "note.txt", content: "one\ntwo\n" }))).toBe("note.txt (2 lines)")
    expect(askedFor("write_file", JSON.stringify({ path: "n.txt", content: "solo" }))).toBe("n.txt (1 line)")
    expect(askedFor("shell", JSON.stringify({ command: "git status" }))).toBe("git status")
    expect(askedFor("webfetch", JSON.stringify({ url: "https://example.com" }))).toBe("https://example.com")
    expect(askedFor("autonomous run", "3 tool calls this turn - keep going")).toBe("3 tool calls this turn - keep going")
    expect(askedFor("mcp__x__y", '{"q":1}')).toBe('{"q":1}')
  })
})
