import { describe, expect, test } from "bun:test"
import {
  empty,
  selection,
  selectedText,
  wordStart,
  wordEnd,
  moveTo,
  insert,
  deleteRange,
  selectAll,
  ComposerHistory,
  layoutComposer,
  caretInComposer,
  offsetInComposerLine,
  moveLine,
  lineEdge,
  type Composer,
} from "../src/tui/composer"

const at = (text: string, cursor: number): Composer => ({ text, cursor })

describe("moving by word", () => {
  test("steps back over the word behind the caret", () => {
    expect(wordStart("one two three", 13)).toBe(8)
    expect(wordStart("one two three", 8)).toBe(4)
  })

  test("skips the gap first, so it lands before a word and not inside the space", () => {
    expect(wordStart("one two   ", 10)).toBe(4)
    expect(wordEnd("   one two", 0)).toBe(6)
  })

  test("stops at the ends rather than running off", () => {
    expect(wordStart("hello", 0)).toBe(0)
    expect(wordEnd("hello", 5)).toBe(5)
  })

  test("treats punctuation as a boundary, not a word", () => {
    expect(wordStart("foo.bar", 7)).toBe(4)
    expect(wordStart("src/core/tools.ts", 17)).toBe(15)
  })

  test("counts letters and digits from any language as word characters", () => {
    expect(wordStart("hello 世界", 8)).toBe(6)
    expect(wordStart("var2 var3", 9)).toBe(5)
  })
})

describe("selecting", () => {
  test("nothing is selected until the anchor and caret differ", () => {
    expect(selection(at("hello", 2))).toBeUndefined()
    expect(selection({ text: "hello", cursor: 2, anchor: 2 })).toBeUndefined()
  })

  test("reads low to high whichever way it was made", () => {
    expect(selection({ text: "hello", cursor: 4, anchor: 1 })).toEqual({ from: 1, to: 4 })
    expect(selection({ text: "hello", cursor: 1, anchor: 4 })).toEqual({ from: 1, to: 4 })
  })

  test("shift-arrow extends from where the caret was", () => {
    let state = at("one two three", 4)
    state = moveTo(state, { to: 7, select: true })
    expect(selectedText(state)).toBe("two")
  })

  // Holding the anchor rather than a sorted range is what makes this work.
  test("shrinks again when you come back, instead of starting a new selection", () => {
    let state = at("one two three", 0)
    state = moveTo(state, { to: 7, select: true })
    state = moveTo(state, { to: 3, select: true })
    expect(selectedText(state)).toBe("one")
  })

  test("moving without shift drops the selection", () => {
    let state = moveTo(at("hello", 0), { to: 3, select: true })
    state = moveTo(state, { to: 4, select: false })
    expect(selection(state)).toBeUndefined()
  })

  test("select all covers the whole prompt", () => {
    expect(selectedText(selectAll(at("one two", 3)))).toBe("one two")
  })
})

describe("deleting", () => {
  // The thing that was missing: highlight several words, press backspace, and
  // lose exactly those words rather than one character or the whole line.
  test("a selection goes first, whichever delete key it was", () => {
    // "this " selected, trailing space included, so what is left reads right.
    const state = { text: "keep this away", cursor: 10, anchor: 5 }
    for (const kind of ["back", "forward", "wordBack", "toEnd"] as const) {
      expect([kind, deleteRange(state, kind).text]).toEqual([kind, "keep away"])
    }
    expect(deleteRange(state, "back").cursor).toBe(5)
  })

  test("backspace takes one character when nothing is selected", () => {
    expect(deleteRange(at("hello", 5), "back")).toEqual({ text: "hell", cursor: 4 })
    expect(deleteRange(at("hello", 0), "back")).toEqual(at("hello", 0))
  })

  test("delete takes the character in front", () => {
    expect(deleteRange(at("hello", 0), "forward")).toEqual({ text: "ello", cursor: 0 })
    expect(deleteRange(at("hello", 5), "forward")).toEqual(at("hello", 5))
  })

  test("word delete takes the word, not the line", () => {
    expect(deleteRange(at("one two three", 13), "wordBack").text).toBe("one two ")
    expect(deleteRange(at("one two three", 0), "wordForward").text).toBe(" two three")
  })

  test("to-end and to-start cut in one direction only", () => {
    expect(deleteRange(at("one two", 3), "toEnd")).toEqual({ text: "one", cursor: 3 })
    expect(deleteRange(at("one two", 4), "toStart")).toEqual({ text: "two", cursor: 0 })
  })
})

describe("typing", () => {
  test("inserts at the caret", () => {
    expect(insert(at("ac", 1), "b")).toEqual({ text: "abc", cursor: 2 })
  })

  test("replaces a selection, the way typing over highlighted text should", () => {
    const state = { text: "hello world", cursor: 11, anchor: 6 }
    expect(insert(state, "there")).toEqual({ text: "hello there", cursor: 11 })
  })

  test("a paste replaces a selection too", () => {
    const state = { text: "keep drop", cursor: 9, anchor: 5 }
    expect(insert(state, "[Pasted ~9 lines]").text).toBe("keep [Pasted ~9 lines]")
  })
})

describe("undoing the prompt itself", () => {
  test("brings back what was there before", () => {
    const history = new ComposerHistory()
    const before = at("a long prompt", 13)
    history.remember(before)
    const after = deleteRange(before, "toStart")
    expect(history.undo(after)).toEqual(before)
  })

  test("redo puts it back again", () => {
    const history = new ComposerHistory()
    const before = at("hello", 5)
    history.remember(before)
    const after = at("", 0)
    const undone = history.undo(after)!
    expect(undone.text).toBe("hello")
    expect(history.redo(undone)!.text).toBe("")
  })

  test("nothing to undo is undefined, not a crash", () => {
    expect(new ComposerHistory().undo(empty)).toBeUndefined()
    expect(new ComposerHistory().redo(empty)).toBeUndefined()
  })

  test("does not record the same text twice in a row", () => {
    const history = new ComposerHistory()
    history.remember(at("same", 4))
    history.remember(at("same", 2))
    expect(history.undo(at("changed", 7))!.text).toBe("same")
    expect(history.undo(at("same", 4))).toBeUndefined()
  })

  test("new work forgets the redo branch", () => {
    const history = new ComposerHistory()
    history.remember(at("one", 3))
    const undone = history.undo(at("two", 3))!
    history.remember(undone)
    expect(history.redo(undone)).toBeUndefined()
  })
})

describe("word-wrapping and multi-line movement in the composer", () => {
  test("never splits a word across two lines when the word fits the box", () => {
    const text =
      "Another thing I learned, and I'm putting it over here, is that the text doesn't seem to wrap properly at there of some words, and you can see it right here."
    const rows = layoutComposer(text, 112)
    expect(rows.map((r) => r.text)).toEqual([
      "Another thing I learned, and I'm putting it over here, is that the text doesn't seem to wrap properly at there ",
      "of some words, and you can see it right here.",
    ])
  })

  test("up and down move between wrapped lines before touching prompt history", () => {
    const text = "first line of words that wraps onto a second visual row cleanly"
    const start: Composer = { text, cursor: text.length }
    const up = moveLine(start, 28, -1)!
    expect(up).toBeDefined()
    expect(caretInComposer(layoutComposer(text, 28), up.cursor).line).toBe(
      caretInComposer(layoutComposer(text, 28), text.length).line - 1,
    )
    // At the top visual row, moveLine returns undefined so Up can recall prompt history.
    expect(moveLine({ text, cursor: 2 }, 28, -1)).toBeUndefined()
  })

  test("explicit newlines, emoji carets and mouse column clicks stay exact", () => {
    const text = "hi 🧌 there\nsecond line"
    const rows = layoutComposer(text, 40)
    expect(rows.map((r) => r.text)).toEqual(["hi 🧌 there", "second line"])
    // "hi " is 3 cols, "🧌" is 2 cols (UTF-16 length 2, indices 3..5), space at index 5 -> column 5.
    expect(caretInComposer(rows, 5)).toEqual({ line: 0, column: 5 })
    expect(offsetInComposerLine(rows[0]!, 5)).toBe(5)
    expect(lineEdge(rows, text.length, "start")).toBe(12)
    expect(lineEdge(rows, 12, "start")).toBe(0)
  })
})
