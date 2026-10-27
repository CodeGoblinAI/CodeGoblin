import { expect, test } from "bun:test"
import { footerHeight } from "../src/tui/layout"
import { renderPalette } from "../src/tui/palette"
import { plain } from "../src/tui/dialog"

test("a six-line draft reserves all six lines even during a reply", () => {
  const footer = footerHeight({ prompt: 6 })
  expect(footer).toBe(10)
  for (const rows of [18, 24, 40]) expect(Math.max(1, rows - footer - 1) + footer).toBeLessThan(rows)
})

test("queued, image and back-to-latest rows count toward the footer", () => {
  expect(footerHeight({ prompt: 6, queued: true, images: true, scrolled: true })).toBe(13)
  expect(footerHeight({ prompt: 1, pending: 6, overlay: 5, plan: 3, palette: 4 })).toBe(23)
})

test("a short palette stays framed and keeps a selected late entry visible", () => {
  const items = Array.from({ length: 40 }, (_, index) => ({ value: "/item-" + index, hint: "fixture" }))
  const drawn = renderPalette(items, 37, 60, 6).map(plain)
  expect(drawn.length).toBeLessThanOrEqual(6)
  expect(drawn.some(line => line.includes("❯ /item-37"))).toBe(true)
  expect(drawn.at(-1)).toContain("╯")
})

test("a palette never draws a partial frame when less than four rows fit", () => {
  expect(renderPalette([{ value: "/model", hint: "fixture" }], 0, 60, 3)).toEqual([])
})
