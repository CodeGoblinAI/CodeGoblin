import { expect, test, describe } from "bun:test"
import {
  open,
  move,
  selected,
  withRows,
  firstVisible,
  dialogWidth,
  dialogHeight,
  box,
  compose,
  plain,
  type DialogRow,
} from "../src/tui/dialog"

const rows = (...labels: string[]): DialogRow[] => labels.map((label) => ({ label, value: label }))

describe("moving through a dialog", () => {
  test("a requested current value opens selected and scrolls into view", () => {
    const dialog = open("test", "Models", rows(...Array.from({ length: 40 }, (_, index) => "model-" + index)), { selectedValue: "model-37" })
    expect(selected(dialog)?.value).toBe("model-37")
    const start = firstVisible(dialog, 10)
    expect(dialog.index).toBeGreaterThanOrEqual(start)
    expect(dialog.index).toBeLessThan(start + 10)
  })

  test("a missing or inert current value falls back to the first selectable row", () => {
    const options: DialogRow[] = [{ label: "Heading", value: "heading", inert: true }, { label: "one", value: "one" }]
    expect(selected(open("test", "T", options, { selectedValue: "missing" }))?.value).toBe("one")
    expect(selected(open("test", "T", options, { selectedValue: "heading" }))?.value).toBe("one")
  })

  test("an omitted current value does not prefer an unvalued row", () => {
    expect(selected(open("test", "T", [{ label: "one", value: "one" }, { label: "two" }]))?.value).toBe("one")
  })

  test("it opens on the first row that can be chosen", () => {
    const dialog = open("test", "Title", [
      { label: "Heading", inert: true },
      { label: "one", value: "one" },
    ])
    expect(dialog.index).toBe(1)
    expect(selected(dialog)?.value).toBe("one")
  })

  test("the selection skips headings and spacers", () => {
    const dialog = open("test", "Title", [
      { label: "a", value: "a" },
      { label: "----", inert: true },
      { label: "b", value: "b" },
    ])
    expect(selected(move(dialog, 1))?.value).toBe("b")
  })

  test("it stops at the ends rather than wrapping", () => {
    // Wrapping means one press too many silently takes you to the other end,
    // which is only noticed after acting on the wrong row.
    const dialog = open("test", "Title", rows("a", "b", "c"))
    expect(selected(move(dialog, -5))?.value).toBe("a")
    expect(selected(move(dialog, 99))?.value).toBe("c")
  })

  test("a dialog with nothing to choose does not move or crash", () => {
    const dialog = open("test", "Title", [{ label: "nothing here", inert: true }])
    expect(selected(dialog)).toBeUndefined()
    expect(move(dialog, 1)).toEqual(dialog)
  })
})

describe("arming a destructive key", () => {
  test("moving away disarms", () => {
    const dialog = { ...open("test", "Title", rows("a", "b")), armed: "a" }
    expect(move(dialog, 1).armed).toBeUndefined()
  })

  test("replacing the rows disarms", () => {
    const dialog = { ...open("test", "Title", rows("a", "b")), armed: "a" }
    expect(withRows(dialog, rows("b")).armed).toBeUndefined()
  })
})

describe("replacing rows", () => {
  test("the selection stays where it still can", () => {
    const dialog = move(open("test", "Title", rows("a", "b", "c")), 2)
    expect(withRows(dialog, rows("a", "b", "c")).index).toBe(2)
  })

  test("a selection past the end comes back to the first row", () => {
    const dialog = move(open("test", "Title", rows("a", "b", "c")), 2)
    expect(withRows(dialog, rows("a")).index).toBe(0)
  })
})

describe("the visible window", () => {
  test("a short list starts at the top", () => {
    expect(firstVisible(open("test", "T", rows("a", "b")), 10)).toBe(0)
  })

  test("the selection is kept on screen", () => {
    const dialog = move(open("test", "T", rows(...Array.from({ length: 40 }, (_, i) => "row " + i))), 30)
    const start = firstVisible(dialog, 9)
    expect(dialog.index).toBeGreaterThanOrEqual(start)
    expect(dialog.index).toBeLessThan(start + 9)
  })

  test("the window stays full at the end of a long list", () => {
    const dialog = move(open("test", "T", rows(...Array.from({ length: 40 }, (_, i) => "row " + i))), 99)
    expect(firstVisible(dialog, 9)).toBe(31)
  })
})

describe("size", () => {
  test("it never outgrows the terminal", () => {
    const dialog = open("test", "T", rows("a"), { size: "large" })
    expect(dialogWidth(dialog, 40)).toBeLessThanOrEqual(40)
  })

  test("full takes the width it is given", () => {
    const dialog = open("test", "T", rows("a"), { size: "full" })
    expect(dialogWidth(dialog, 120)).toBe(112)
  })

  test("a very short terminal still leaves one row of content", () => {
    expect(dialogHeight(open("test", "T", rows("a", "b", "c")), 6)).toBe(1)
  })
})

describe("drawing", () => {
  const cols = 80
  const rowsHigh = 30

  test("every line of the box is exactly the same width", () => {
    const drawn = box(open("test", "Settings", rows("one", "two")), cols, rowsHigh)
    const widths = new Set(drawn.map((line) => plain(line).length))
    expect(widths.size).toBe(1)
  })

  test("a title longer than the box does not run through the border", () => {
    const dialog = open("test", "x".repeat(200), rows("one"))
    const drawn = box(dialog, cols, rowsHigh)
    for (const line of drawn) expect(plain(line).length).toBeLessThanOrEqual(cols)
  })

  test("a label longer than the box is cut, not wrapped", () => {
    const drawn = box(open("test", "T", rows("y".repeat(300))), cols, rowsHigh)
    expect(drawn.every((line) => plain(line).length <= cols)).toBe(true)
  })

  test("a scrolling list says where it is", () => {
    const dialog = open("test", "T", rows(...Array.from({ length: 50 }, (_, i) => "row " + i)))
    expect(box(dialog, cols, rowsHigh).some((line) => plain(line).includes("of 50"))).toBe(true)
  })

  test("the way out is always on screen", () => {
    expect(box(open("test", "T", rows("a")), cols, rowsHigh).some((line) => plain(line).includes("esc"))).toBe(true)
  })
})

describe("compositing", () => {
  const cols = 60
  const rowsHigh = 24
  const base = Array.from({ length: 20 }, (_, i) => "base line " + i)

  test("the box sits on top and the backdrop shows either side", () => {
    // Wide enough that there is a backdrop left to see: a medium box on a
    // narrow terminal legitimately covers nearly all of it.
    const wide = 100
    const backdrop = Array.from({ length: 20 }, () => "z".repeat(wide))
    const drawn = box(open("test", "T", rows("one")), wide, rowsHigh)
    const out = compose(backdrop, drawn, wide, rowsHigh)
    const boxRow = plain(out.find((line) => plain(line).includes("one"))!)
    expect(boxRow.startsWith("z".repeat(10))).toBe(true)
    expect(boxRow.endsWith("z".repeat(10))).toBe(true)
    expect(boxRow).toContain("one")
  })

  test("no composed line is wider than the terminal", () => {
    const drawn = box(open("test", "T", rows("one", "two")), cols, rowsHigh)
    for (const line of compose(base, drawn, cols, rowsHigh)) {
      expect(plain(line).length).toBeLessThanOrEqual(cols + 1)
    }
  })

  test("a box taller than the backdrop still draws whole", () => {
    const tall = open("test", "T", rows(...Array.from({ length: 12 }, (_, i) => "row " + i)))
    const drawn = box(tall, cols, rowsHigh)
    const out = compose(["only one line"], drawn, cols, rowsHigh)
    expect(out.length).toBeGreaterThanOrEqual(drawn.length)
    expect(out.some((line) => plain(line).includes("row 0"))).toBe(true)
  })

  test("the backdrop keeps its text, only its colour goes", () => {
    const coloured = ["[38;2;1;2;3mhello[0m"]
    const drawn = box(open("test", "T", rows("one")), cols, rowsHigh)
    const out = compose(coloured, drawn, cols, rowsHigh)
    expect(plain(out[0])).toContain("hello")
  })
})

describe("arming shows", () => {
  test("an armed row says so where its hint was", () => {
    const dialog = { ...open("test", "T", [{ label: "a chat", hint: "open", value: "a" }]), armed: "a" }
    const drawn = box(dialog, 80, 30).map(plain).join(" ")
    expect(drawn).toContain("press again to delete")
    expect(drawn).not.toContain("open")
  })

  test("an unarmed row keeps its own hint", () => {
    const dialog = open("test", "T", [{ label: "a chat", hint: "open", value: "a" }])
    expect(box(dialog, 80, 30).map(plain).join(" ")).toContain("open")
  })
})
