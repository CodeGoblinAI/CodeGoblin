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

describe("the empty conversation's layout around the composer", () => {
  const { homeLayout } = require("../src/tui/wordmark") as typeof import("../src/tui/wordmark")
  const composerRow = (layout: { above: string[] }, taken: number) => layout.above.length + taken

  test("always exactly the rows it is given, whatever is open", () => {
    for (const room of [3, 8, 12, 20, 30, 45]) {
      for (const taken of [0, 4, 11]) {
        for (const notice of [0, 1, 2]) {
          // The app always leaves at least one row here.
          if (taken + notice >= room) continue
          const layout = homeLayout(120, room, taken + notice, "~/proj:main", plain, notice)
          expect([room, taken, notice, layout.above.length + layout.below.length]).toEqual([room, taken, notice, room - taken - notice])
        }
      }
    }
  })

  test("the composer sits under the wordmark, with the folder on the last row", () => {
    const layout = homeLayout(120, 30, 0, "~/proj:main", plain)
    const text = layout.above.join("\n")
    expect(text).toContain(WORDMARK[0]!)
    expect(text).toContain(HOME_TIP)
    expect(layout.above.at(-1)).toBe("")
    expect(layout.below.length).toBeGreaterThan(5)
    expect(layout.below.at(-1)).toContain("~/proj:main")
  })

  test("a notice takes the blank row, so the composer does not move", () => {
    const quiet = homeLayout(120, 30, 0, "~/proj:main", plain)
    const noted = homeLayout(120, 30, 1, "~/proj:main", plain, 1)
    expect(composerRow(noted, 1)).toBe(composerRow(quiet, 0))
    expect(noted.above.join("\n")).toContain(WORDMARK[0]!)
  })

  test("the command list takes its rows from below; the wordmark stays where it was", () => {
    const quiet = homeLayout(120, 30, 0, "", plain)
    const listed = homeLayout(120, 30, 11, "", plain)
    expect(listed.above.findIndex((line) => line.includes(WORDMARK[0]!))).toBe(quiet.above.findIndex((line) => line.includes(WORDMARK[0]!)))
  })
})

describe("the tip under the start line", () => {
  test("is shown when set, is the first thing dropped when rows are short, and every tip fits an 80-column window", async () => {
    const { TIPS, pickTip, setHomeTip } = await import("../src/tui/wordmark")
    try {
      setHomeTip(TIPS[0]!)
      expect(homeScreen(120, 30, "~/proj:main", plain).join("\n")).toContain("tip: " + TIPS[0])
      // Twelve rows hold everything but the tip.
      const tight = homeScreen(120, 12, "~/proj:main", plain).join("\n")
      expect(tight).toContain("~/proj:main")
      expect(tight).not.toContain("tip: ")
    } finally { setHomeTip("") }
    expect(homeScreen(120, 30, "~/proj:main", plain).join("\n")).not.toContain("tip: ")
    for (const tip of TIPS) expect(("tip: " + tip).length).toBeLessThanOrEqual(78)
    expect(pickTip(() => 0)).toBe(TIPS[0]!)
    expect(pickTip(() => 0.999)).toBe(TIPS.at(-1)!)
  })
})
