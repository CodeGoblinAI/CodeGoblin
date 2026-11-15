import { describe, expect, test } from "bun:test"
import { cellsOf, isEmpty, ordered, paint, rowsOf, textOf } from "../src/tui/screen-select"

const ESC = String.fromCharCode(27)
const frame = [
  "",
  `  ${ESC}[1mWhat it does:${ESC}[0m the model can start a command`,
  "    that keeps running (a dev server).",
  "",
  `  ${ESC}[38;2;10;20;30mconst a = 1${ESC}[0m          `,
  "  日本語 text",
]

describe("selecting text on the screen", () => {
  test("a line's cells ignore colour codes and give a wide character two columns", () => {
    expect(cellsOf(`${ESC}[1mab${ESC}[0mc`)).toEqual(["a", "b", "c"])
    expect(cellsOf("日x")).toEqual(["日", "", "x"])
  })

  test("a drag within one row takes those columns", () => {
    expect(textOf(frame, { from: { row: 2, col: 3 }, to: { row: 2, col: 15 } })).toBe("What it does:")
    // Dragged right to left is the same selection.
    expect(textOf(frame, { from: { row: 2, col: 15 }, to: { row: 2, col: 3 } })).toBe("What it does:")
    expect(ordered({ from: { row: 3, col: 1 }, to: { row: 2, col: 9 } }).from.row).toBe(2)
  })

  test("a drag over several rows takes the first from its start, the last to its end, and the middle whole", () => {
    const text = textOf(frame, { from: { row: 2, col: 17 }, to: { row: 3, col: 22 } })
    expect(text).toBe("the model can start a command\n    that keeps running")
  })

  test("the margin the rows share is left out, trailing blanks too, and blank rows at the ends", () => {
    expect(textOf(frame, { from: { row: 1, col: 1 }, to: { row: 5, col: 40 } })).toBe("What it does: the model can start a command\n  that keeps running (a dev server).\n\nconst a = 1")
  })

  test("past the end of a line there is nothing, and a wide character is taken whole", () => {
    expect(textOf(frame, { from: { row: 5, col: 30 }, to: { row: 5, col: 60 } })).toBe("")
    expect(textOf(frame, { from: { row: 6, col: 4 }, to: { row: 6, col: 6 } })).toBe("日本")
    expect(isEmpty({ from: { row: 2, col: 2 }, to: { row: 2, col: 2 } })).toBe(true)
  })

  test("the bar an answer is drawn behind is not part of what is copied", () => {
    const answer = ["  | The quick brown fox.", "  |", "  | Second paragraph.", "    │ tick 1", "    │ tick 2"]
    expect(textOf(answer, { from: { row: 1, col: 9 }, to: { row: 3, col: 10 } })).toBe("quick brown fox.\n\nSecond")
    expect(textOf(answer, { from: { row: 1, col: 1 }, to: { row: 3, col: 40 } })).toBe("The quick brown fox.\n\nSecond paragraph.")
    expect(textOf(answer, { from: { row: 4, col: 1 }, to: { row: 5, col: 40 } })).toBe("tick 1\ntick 2")
    // One row is taken as it is drawn: a line of a table that starts with a bar keeps it.
    expect(textOf(["| a | b |"], { from: { row: 1, col: 1 }, to: { row: 1, col: 9 } })).toBe("| a | b |")
  })

  test("the highlight redraws exactly the selected cells, where they are", () => {
    const drawn = paint(frame, { from: { row: 2, col: 3 }, to: { row: 3, col: 8 } }, "<sel>", "<end>")
    expect(drawn).toBe(`${ESC}[2;3H<sel>What it does: the model can start a command<end>${ESC}[3;1H<sel>    that<end>`)
    // A row with nothing drawn on it is not painted.
    expect(rowsOf(frame, { from: { row: 4, col: 1 }, to: { row: 4, col: 10 } })[0]!.text).toBe("")
    expect(paint(frame, { from: { row: 4, col: 1 }, to: { row: 4, col: 10 } }, "<sel>", "<end>")).toBe("")
  })
})
