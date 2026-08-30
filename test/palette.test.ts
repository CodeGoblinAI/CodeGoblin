import { describe, expect, test } from "bun:test"
import { paletteFor } from "../src/tui/palette"

/**
 * The rule the TUI applies on enter:
 *   - a BARE command that expands (paletteFor("<cmd> ") returns items) fills
 *     in and reopens the palette
 *   - anything containing a space is a complete choice and runs
 *
 * Both halves have broken in use, so both are pinned here.
 */
describe("palette expansion", () => {
  test("typing a slash lists commands", () => {
    const items = paletteFor("/")
    expect(items?.some((i) => i.value === "/model")).toBe(true)
  })

  test("filters as you type", () => {
    expect(paletteFor("/mod")?.every((i) => i.value.startsWith("/mod"))).toBe(true)
  })

  // Regression: /model + enter printed the help text instead of offering
  // models, because the typed text equalled the highlighted item.
  test("/model expands into a model list", () => {
    const expanded = paletteFor("/model ")
    expect(expanded?.length).toBeGreaterThan(1)
    expect(expanded?.every((i) => i.value.startsWith("/model "))).toBe(true)
  })

  // Regression: a chosen model re-expanded instead of applying, so picking
  // one did nothing.
  test("a complete model choice contains a space, marking it final", () => {
    const chosen = paletteFor("/model ")![0]!.value
    expect(chosen.includes(" ")).toBe(true)
  })

  test("a command taking no argument does not expand", () => {
    expect(paletteFor("/help ")).toBeUndefined()
    expect(paletteFor("/new ")).toBeUndefined()
  })

  test("model list narrows on a query", () => {
    const glm = paletteFor("/model glm")
    expect(glm?.length).toBeGreaterThan(0)
    expect(glm?.every((i) => i.value.includes("glm"))).toBe(true)
  })

  test("plain text opens nothing", () => {
    expect(paletteFor("hello")).toBeUndefined()
  })
})

describe("resume is a picker now, not a completion", () => {
  // Completing "/resume " to an id was a second way in that skipped the
  // panel - and the panel is the only place a conversation can be deleted,
  // so the delete was hidden behind the path nobody took.
  test("/resume offers the command and nothing more", () => {
    expect(paletteFor("/resume")?.map((i) => i.value)).toEqual(["/resume"])
  })

  test("a trailing space no longer expands into ids", () => {
    expect(paletteFor("/resume ")).toBeUndefined()
  })
})
