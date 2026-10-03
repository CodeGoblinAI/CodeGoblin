import { afterEach, describe, expect, test } from "bun:test"
import { paletteFor, setConnectedProviders, slashToken, slashRange } from "../src/tui/palette"

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

describe("the model list says which models can actually run", () => {
  afterEach(() => setConnectedProviders([]))

  test("a provider with no key is marked", () => {
    setConnectedProviders(["deepseek"])
    const glm = paletteFor("/model glm")!
    expect(glm.every((item) => item.hint.includes("no key"))).toBe(true)
  })

  test("a provider with a key is not", () => {
    setConnectedProviders(["deepseek"])
    const deepseek = paletteFor("/model deepseek")!
    expect(deepseek.some((item) => item.hint.includes("no key"))).toBe(false)
  })

  test("connecting a provider changes what the list says about it", () => {
    setConnectedProviders([])
    expect(paletteFor("/model glm")!.every((item) => item.hint.includes("no key"))).toBe(true)
    setConnectedProviders(["zai"])
    expect(paletteFor("/model glm")!.some((item) => item.hint.includes("no key"))).toBe(false)
  })

  test("the marking never eats the model's own name", () => {
    setConnectedProviders([])
    const glm = paletteFor("/model glm-5.3")!
    expect(glm[0]!.hint).toContain("GLM 5.3")
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

describe("slash mid-prompt", () => {
  test("a word-starting / completes command names", () => {
    expect(slashToken("hi there /", 10)).toBe("/")
    expect(slashToken("hi there /cl", 12)).toBe("/cl")
    expect(slashRange("hi there /cl", 12)).toEqual({ start: 9, end: 12 })
    const items = paletteFor("hi there /cl", 12)
    expect(items?.length).toBeGreaterThan(0)
    expect(items?.every((i) => i.value.startsWith("/cl"))).toBe(true)
    expect(items?.some((i) => i.value === "/clear")).toBe(true)
  })

  test("slashes inside words never trigger", () => {
    expect(slashToken("a/b", 3)).toBeUndefined()
    expect(slashToken("costs $5/day", 11)).toBeUndefined()
    expect(slashToken("hi /clear and /model", 20)).toBe("/model")
    expect(paletteFor("a/b", 3)).toBeUndefined()
    expect(paletteFor("hi there", 8)).toBeUndefined()
  })
})
