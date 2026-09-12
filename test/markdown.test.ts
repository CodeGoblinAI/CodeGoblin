import { describe, expect, test } from "bun:test"
import { renderMarkdown } from "../src/tui/markdown"
import { displayWidth } from "../src/tui/width"

/** What the terminal shows, with the colour codes taken back out. */
const plain = (text: string, width = 90) =>
  renderMarkdown(text, width).map((line) => line.replace(/\[[0-9;]*m/g, ""))

const TABLE = [
  "| Script | Command | Purpose |",
  "|---|---|---|",
  "| tui | bun src/tui/app.ts | The terminal app |",
  "| web | bun src/web/serve.ts | The web server |",
].join("\n")

describe("markdown tables", () => {
  test("a table is drawn as a grid, not left as pipes", () => {
    const lines = plain(TABLE)
    expect(lines.some((line) => line.includes("┌"))).toBe(true)
    expect(lines.some((line) => line.includes("└"))).toBe(true)
    // The header text survives; the markup around it does not.
    expect(lines.some((line) => line.includes("Script") && line.includes("Purpose"))).toBe(true)
    expect(lines.some((line) => line.includes("|---|"))).toBe(false)
  })

  test("every row is the same width, which is the point of a grid", () => {
    const widths = new Set(plain(TABLE).filter((line) => line.trim()).map(displayWidth))
    expect(widths.size).toBe(1)
  })

  test("the rows are consecutive - nothing blank between them", () => {
    // A terminal capture once showed this double-spaced. It was the harness,
    // not the renderer, and this is how that stays answerable.
    expect(plain(TABLE).filter((line) => !line.trim()).length).toBe(0)
  })

  test("a table never draws wider than the pane it is given", () => {
    for (const width of [30, 44, 60, 100]) {
      for (const line of plain(TABLE, width)) expect(displayWidth(line)).toBeLessThanOrEqual(width)
    }
  })

  test("a cell too narrow to fit says it was cut", () => {
    const lines = plain(TABLE, 34)
    expect(lines.some((line) => line.includes("…"))).toBe(true)
  })

  test("the alignment row decides the alignment", () => {
    const lines = plain(["| a | b |", "|---:|:--:|", "| 1 | 2 |"].join("\n"), 40)
    const row = lines.find((line) => line.includes("1"))!
    // Right-aligned: padding before the value. Centred: padding on both sides.
    expect(row).toMatch(/│\s+1 │/)
    expect(row).toMatch(/│ +2 +│/)
  })

  test("a ragged row is padded rather than dropped", () => {
    const lines = plain(["| a | b | c |", "|---|---|---|", "| 1 |"].join("\n"))
    expect(lines.some((line) => line.includes("1"))).toBe(true)
  })

  test("an escaped pipe stays inside its cell", () => {
    const lines = plain(["| kind | glob |", "|---|---|", "| any | a\\|b |"].join("\n"))
    expect(lines.some((line) => line.includes("a|b"))).toBe(true)
  })

  test("pipes without an alignment row are a sentence, not a table", () => {
    const lines = plain("The command is | tee log.txt | wc -l, roughly.")
    expect(lines.some((line) => line.includes("┌"))).toBe(false)
  })

  test("a table inside a code fence stays code", () => {
    const lines = plain(["```", "| a | b |", "|---|---|", "```"].join("\n"))
    expect(lines.some((line) => line.includes("┌─ code"))).toBe(true)
    expect(lines.some((line) => line.includes("|---|"))).toBe(true)
  })

  test("prose either side of a table is still prose", () => {
    const lines = plain(["Before.", "", TABLE, "", "After."].join("\n"))
    expect(lines[0]).toContain("Before.")
    expect(lines[lines.length - 1]).toContain("After.")
  })
})

describe("markdown, the parts that already worked", () => {
  test("a fenced block is boxed and labelled", () => {
    const lines = plain(["```ts", "const x = 1", "```"].join("\n"))
    expect(lines[0]).toContain("┌─ ts")
    expect(lines.some((line) => line.includes("const x = 1"))).toBe(true)
  })

  test("bullets get a marker and headings lose their hashes", () => {
    const lines = plain(["## Title", "- one", "- two"].join("\n"))
    expect(lines.some((line) => line.includes("Title") && !line.includes("##"))).toBe(true)
    expect(lines.filter((line) => line.includes("•")).length).toBe(2)
  })
})
