import { describe, expect, test } from "bun:test"
import { COMPACT, HOME_TIP, TAGLINE, WORDMARK, homeScreen } from "../src/tui/wordmark"

const plain = { goblin: "", gold: "", dim: "", reset: "" }
const width = (line: string) => [...line].length

describe("the terminal's empty conversation", () => {
  test("a roomy screen: wordmark, rule, tagline, tip and place, set in the middle", () => {
    const lines = homeScreen(120, 30, "~/proj:main", plain)
    const first = lines.findIndex((line) => line.trim())
    expect(first).toBeGreaterThan(3)
    expect(lines.length).toBeLessThanOrEqual(30)
    const text = lines.join("\n")
    expect(text).toContain(WORDMARK[0]!)
    expect(text).toContain("─".repeat(20))
    expect(text).toContain(TAGLINE)
    expect(text).toContain(HOME_TIP)
    expect(text).toContain("~/proj:main")
    // Centred: the tagline has as much space before it as after, give or take one.
    const tagline = lines.find((line) => line.includes(TAGLINE))!
    expect(Math.abs(tagline.indexOf(TAGLINE) - (120 - tagline.length))).toBeLessThanOrEqual(1)
  })

  test("it never draws more rows than it has, giving up the extras first", () => {
    for (const height of [1, 3, 6, 7, 9, 10, 12, 40]) {
      const lines = homeScreen(120, height, "~/proj:main", plain)
      expect([height, lines.length <= height]).toEqual([height, true])
    }
    const tight = homeScreen(120, 7, "~/proj:main", plain).join("\n")
    expect(tight).toContain(WORDMARK[5]!)
    expect(tight).not.toContain(HOME_TIP)
    expect(homeScreen(120, 9, "~/proj:main", plain).join("\n")).toContain(TAGLINE)
  })

  test("a narrow terminal gets the plain name and nothing wider than itself", () => {
    for (const cols of [20, 30, 50, 70, 82]) {
      const lines = homeScreen(cols, 20, "~/a/very/long/folder/name/that/does/not/fit/in/the/window:feature/branch", plain)
      expect(lines.join("\n")).toContain(COMPACT)
      for (const line of lines) expect([cols, width(line) <= cols]).toEqual([cols, true])
    }
    expect(homeScreen(30, 20, "", plain).join("\n")).not.toContain(TAGLINE)
  })
})
