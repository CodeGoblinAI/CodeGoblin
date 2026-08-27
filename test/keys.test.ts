import { describe, expect, test } from "bun:test"
import { parseKeys } from "../src/tui/keys"

const ESC = String.fromCharCode(27)

describe("key parsing", () => {
  // The bug this exists to prevent: arrow keys read as Escape and quit.
  test("arrow keys are arrows, not escape", () => {
    expect(parseKeys(ESC + "[A")).toEqual([{ type: "up" }])
    expect(parseKeys(ESC + "[B")).toEqual([{ type: "down" }])
    expect(parseKeys(ESC + "[C")).toEqual([{ type: "right" }])
    expect(parseKeys(ESC + "[D")).toEqual([{ type: "left" }])
  })

  test("a lone escape is still escape", () => {
    expect(parseKeys(ESC)).toEqual([{ type: "escape" }])
  })

  test("home, end, delete and page keys", () => {
    expect(parseKeys(ESC + "[H")).toEqual([{ type: "home" }])
    expect(parseKeys(ESC + "[3~")).toEqual([{ type: "delete" }])
    expect(parseKeys(ESC + "[5~")).toEqual([{ type: "pageup" }])
    expect(parseKeys(ESC + "[6~")).toEqual([{ type: "pagedown" }])
  })

  test("a chunk can hold several keys", () => {
    expect(parseKeys("hi" + String.fromCharCode(13))).toEqual([
      { type: "char", value: "h" },
      { type: "char", value: "i" },
      { type: "enter" },
    ])
  })

  test("paste followed by enter still submits", () => {
    const keys = parseKeys("some pasted text" + String.fromCharCode(13))
    expect(keys[keys.length - 1]).toEqual({ type: "enter" })
  })

  test("control characters report their letter", () => {
    expect(parseKeys(String.fromCharCode(3))).toEqual([{ type: "ctrl", value: "c" }])
    expect(parseKeys(String.fromCharCode(21))).toEqual([{ type: "ctrl", value: "u" }])
  })
})
