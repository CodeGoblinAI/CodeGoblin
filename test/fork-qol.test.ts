import { describe, expect, test } from "bun:test"
import { pasteToken, unfoldPastes, workedFor, type Paste } from "../src/core/sessions"
import { runCommand, COMMANDS, PENDING_COMMANDS } from "../src/core/commands"

describe("worked for", () => {
  test("says how long a turn took the way the fork does", () => {
    expect(workedFor(800)).toBe("0.8s")
    expect(workedFor(9_940)).toBe("9.9s")
    expect(workedFor(12_400)).toBe("12s")
    expect(workedFor(185_000)).toBe("3m 05s")
    expect(workedFor(3_720_000)).toBe("1h 02m")
  })
})

describe("paste summary", () => {
  test("a paste of four lines or more folds to a token; shorter is just typing", () => {
    expect(pasteToken("one line", [])).toBeUndefined()
    expect(pasteToken("a\nb\nc", [])).toBeUndefined()
    expect(pasteToken("a\nb\nc\nd", [])).toBe("[Pasted ~4 lines]")
  })

  test("two pastes of the same length get their own tokens and expand to their own text", () => {
    const waiting: Paste[] = []
    const first = { token: pasteToken("1\n2\n3\n4", waiting)!, text: "1\n2\n3\n4" }
    waiting.push(first)
    const second = { token: pasteToken("a\nb\nc\nd", waiting)!, text: "a\nb\nc\nd" }
    waiting.push(second)
    expect(second.token).toBe("[Pasted ~4 lines #2]")
    expect(unfoldPastes(`look at ${first.token} and ${second.token}`, waiting)).toBe("look at 1\n2\n3\n4 and a\nb\nc\nd")
  })

  test("what the browser sends is checked: only real tokens expand", () => {
    expect(unfoldPastes("x [Pasted ~4 lines] y", [{ token: "[Pasted ~4 lines]", text: "BODY" }])).toBe("x BODY y")
    expect(unfoldPastes("x {{secret}} y", [{ token: "{{secret}}", text: "injected" }])).toBe("x {{secret}} y")
    expect(unfoldPastes("x", "nonsense")).toBe("x")
  })
})

describe("/editor", () => {
  test("is a real command now, not a pending one", () => {
    expect(runCommand("/editor")).toEqual({ kind: "editor" })
    expect(PENDING_COMMANDS["/editor"]).toBeUndefined()
    expect(COMMANDS.filter((c) => c.name === "/editor").length).toBe(1)
  })
})
