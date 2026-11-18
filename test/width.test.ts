import { describe, expect, test } from "bun:test"
import { displayWidth, truncateToWidth, padToWidth, wrapToWidth } from "../src/tui/width"

describe("display width", () => {
  test("ascii is one column per character", () => {
    expect(displayWidth("hello")).toBe(5)
  })

  // The bug this exists for: 14 CJK triples measured 47 by .length but
  // occupied 89 columns, overflowing a 60-column terminal.
  test("CJK is two columns", () => {
    expect(displayWidth("日本語")).toBe(6)
    expect("日本語".length).toBe(3)
  })

  test("emoji is two columns", () => {
    expect(displayWidth("🙂")).toBe(2)
  })

  test("escape sequences take no width", () => {
    const coloured = String.fromCharCode(27) + "[32mhi" + String.fromCharCode(27) + "[0m"
    expect(displayWidth(coloured)).toBe(2)
  })

  test("truncation respects width, not length", () => {
    expect(displayWidth(truncateToWidth("日本語日本語", 6))).toBeLessThanOrEqual(6)
  })

  test("padding reaches the target width", () => {
    expect(displayWidth(padToWidth("日本", 10))).toBe(10)
  })

  test("transport emoji is two columns and wrapping at width 1 terminates on wide glyphs", () => {
    expect(displayWidth("🚀")).toBe(2)
    expect(wrapToWidth("漢🚀a", 1)).toEqual(["漢", "🚀", "a"])
  })
})
