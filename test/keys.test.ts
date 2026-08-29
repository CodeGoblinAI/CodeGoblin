import { describe, expect, test } from "bun:test"
import { parseKeys, createKeyReader } from "../src/tui/keys"

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

describe("a paste that arrives in pieces", () => {
  // stdin hands a big paste over in several chunks. The opening marker landed in
  // the first one with no terminator, so everything after it was read as typing -
  // and every newline in it was an enter, which submitted the prompt over and
  // over as the paste trickled in.
  const ESC = String.fromCharCode(27)
  const NL = String.fromCharCode(10)

  test("is one paste, not a stream of keystrokes and enters", () => {
    const read = createKeyReader()
    const first = read(ESC + "[200~line one" + NL + "line two" + NL)
    expect(first).toEqual([])

    const second = read("line three" + NL + "line four" + ESC + "[201~")
    expect(second.length).toBe(1)
    expect(second[0]).toEqual({
      type: "paste",
      value: ["line one", "line two", "line three", "line four"].join(NL),
    })
  })

  test("holds across as many chunks as it takes", () => {
    const read = createKeyReader()
    read(ESC + "[200~a")
    for (let n = 0; n < 20; n++) expect(read(NL + "x")).toEqual([])
    const done = read(ESC + "[201~")
    expect(done.length).toBe(1)
    expect(done[0]!.type).toBe("paste")
  })

  test("keeps what was typed before the paste began", () => {
    const read = createKeyReader()
    const keys = read("hi" + ESC + "[200~pasted")
    expect(keys.map((k) => k.type)).toEqual(["char", "char"])
    expect(read(ESC + "[201~")[0]).toEqual({ type: "paste", value: "pasted" })
  })

  test("keeps what is typed after it ends, in the same chunk", () => {
    const read = createKeyReader()
    read(ESC + "[200~body")
    const keys = read(ESC + "[201~!")
    expect(keys.map((k) => k.type)).toEqual(["paste", "char"])
  })

  test("a paste whole in one chunk still works", () => {
    const read = createKeyReader()
    expect(read(ESC + "[200~all at once" + ESC + "[201~")).toEqual([
      { type: "paste", value: "all at once" },
    ])
  })

  test("ordinary typing is untouched", () => {
    const read = createKeyReader()
    expect(read("abc").map((k) => k.type)).toEqual(["char", "char", "char"])
  })
})
