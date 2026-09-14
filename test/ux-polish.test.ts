import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { paletteFor, setInvocations } from "../src/tui/palette"
import { displayWidth, padStartToWidth, wrapToWidth } from "../src/tui/width"

/** Asked for after using both surfaces: an ordered, scrolling slash menu, and your messages on the right. */
describe("text on the right-hand side of the terminal", () => {
  test("wraps at spaces, and cuts a word longer than the line", () => {
    expect(wrapToWidth("one two three four", 9)).toEqual(["one two", "three", "four"])
    expect(wrapToWidth("abcdefghij", 4)).toEqual(["abcd", "efgh", "ij"])
    expect(wrapToWidth("short", 20)).toEqual(["short"])
  })

  test("pads on the left by display width, so wide characters line up", () => {
    expect(padStartToWidth("you", 6)).toBe("   you")
    expect(displayWidth(padStartToWidth("🧌", 4))).toBe(4)
  })
})

describe("the terminal's slash menu", () => {
  test("lists the app's commands first, then skills A to Z", () => {
    setInvocations([
      { value: "/zebra", hint: "skill" },
      { value: "/apple", hint: "skill" },
      { value: "/mango", hint: "skill" },
    ])
    const values = paletteFor("/")!.map((item) => item.value)
    const firstSkill = values.indexOf("/apple")
    expect(values.slice(firstSkill)).toEqual(["/apple", "/mango", "/zebra"])
    expect(values.slice(0, firstSkill).length).toBeGreaterThan(5)
    setInvocations([])
  })
})

describe("the web page", () => {
  const web = path.join(import.meta.dir, "..", "src", "web")
  const app = fs.readFileSync(path.join(web, "app.js"), "utf8")
  const page = fs.readFileSync(path.join(web, "index.html"), "utf8")

  test("its slash menu scrolls within a quarter of the window, and keeps the chosen row in sight", () => {
    const rule = page.split("\n").find((line) => line.trim().startsWith(".palette {"))!
    expect(rule).toContain("max-height")
    expect(rule).toContain("overflow-y: auto")
    expect(app).toContain('scrollIntoView({ block: "nearest" })')
  })

  test("its slash menu puts the app's commands before skills, and skills A to Z", () => {
    expect(app).toContain("return [...own, ...invoked]")
    expect(app).toContain("sort((a, b) => a.value.localeCompare(b.value))")
  })

  test("puts your messages on the right", () => {
    expect(page).toContain(".turn.user { flex-direction: row-reverse; }")
  })
})
