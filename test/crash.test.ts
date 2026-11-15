import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { TOO_MANY, WINDOW_MS, carryOn, errorLine, errorText, farewell, logEntry, writeCrash } from "../src/tui/crash"

describe("an error nothing caught", () => {
  test("its text is the stack, and things that are not errors still say something", () => {
    const error = new Error("the list was empty")
    expect(errorText(error)).toContain("the list was empty")
    expect(errorText(error)).toContain("crash.test.ts")
    expect(errorText("")).toBe("(an empty error)")
    expect(errorText(undefined)).toBe("undefined")
    expect(errorText({ code: 7 })).toBe('{"code":7}')
  })

  test("the status line gets the first line of the message, cut to fit", () => {
    expect(errorLine(new Error("cannot read 'x'\nmore"))).toBe("cannot read 'x'")
    expect(errorLine(new TypeError(""))).toBe("TypeError")
    expect(errorLine(new Error("a".repeat(200))).length).toBe(90)
  })

  test("one error is carried on from; several close together are not", () => {
    const times: number[] = []
    for (let n = 1; n < TOO_MANY; n++) expect(carryOn(times, 1000 + n, false)).toBe(true)
    expect(carryOn(times, 1000 + TOO_MANY, false)).toBe(false)
  })

  test("errors spread out over time never add up", () => {
    const times: number[] = []
    for (let n = 0; n < 20; n++) expect(carryOn(times, n * (WINDOW_MS + 1), false)).toBe(true)
  })

  test("an error while drawing the screen is always the end", () => {
    expect(carryOn([], 5, true)).toBe(false)
  })

  test("it is appended to the log, in a folder that may not exist yet", () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cg-crash-")), "log", "tui-crash.log")
    const at = new Date("2026-11-15T20:00:00Z")
    expect(writeCrash(file, logEntry("an error nothing caught", new Error("first"), at, "bun 1.4.1"))).toBe(file)
    writeCrash(file, logEntry("a background task failed", "second", at))
    const text = fs.readFileSync(file, "utf8")
    expect(text).toContain("2026-11-15T20:00:00.000Z  an error nothing caught  (bun 1.4.1)")
    expect(text).toContain("first")
    expect(text).toContain("a background task failed\nsecond")
  })

  test("a log that cannot be written does not throw", () => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), "cg-crash-"))
    fs.writeFileSync(path.join(folder, "log"), "a file where the folder should be")
    expect(writeCrash(path.join(folder, "log", "tui-crash.log"), "x")).toBeUndefined()
  })

  test("the goodbye says what broke, where it is saved, and how to get the conversation back", () => {
    const text = farewell("drawing the screen", new Error("boom"), "C:/logs/tui-crash.log")
    expect(text).toContain("drawing the screen")
    expect(text).toContain("boom")
    expect(text).toContain("C:/logs/tui-crash.log")
    expect(text).toContain("/resume")
    expect(farewell("x", "y", undefined)).not.toContain("saved in")
  })
})
