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
    expect(page).toContain(".turn.user { align-items: flex-end; }")
  })

  test("the empty page puts the composer under the question, and the model inside the box", () => {
    expect(page).toContain("body.home .thread { flex: 0 0 auto;")
    expect(app).toContain('document.body.classList.toggle("home"')
    // The pickers live in the box's own row, after the message.
    const box = page.slice(page.indexOf('<div class="box">'), page.indexOf('<div class="meta">'))
    expect(box.indexOf('id="input"')).toBeLessThan(box.indexOf('id="mode-btn"'))
    expect(box.indexOf('id="mode-btn"')).toBeLessThan(box.indexOf('id="provider-btn"'))
    expect(box.indexOf('id="provider-btn"')).toBeLessThan(box.indexOf('id="send"'))
  })

  test("Settings is sectioned, each row says what it does, and on/off settings are switches", () => {
    const settings = app.slice(app.indexOf("function openSettingsDialog"), app.indexOf("function openHelpDialog"))
    for (const section of ["General", "Appearance", "Model", "Providers"]) expect(settings).toContain('"' + section + '"')
    expect(settings).toContain('setAttribute("role", "switch")')
    expect(settings).toContain('"Search settings"')
    // Each setting is declared with a section, a name and a sentence about it.
    expect(settings.split('toggle("').length + settings.split('choice("').length).toBeGreaterThan(8)
    expect(settings).toContain("The model still gets every line.")
    expect(page).toContain("dialog.settings[open] { display: grid;")
  })

  test("a command's note on the empty page does not send the composer to the bottom", () => {
    expect(app).toContain('child.matches(".empty-hint, .tool.note")')
  })

  test("icon-only buttons keep a name, and activity starts closed", () => {
    for (const id of ["new-session", "settings-open", "help-open", "sessions-toggle", "activity-toggle"]) {
      const tag = page.slice(page.indexOf('id="' + id + '"') - 40, page.indexOf(">", page.indexOf('id="' + id + '"')))
      expect([id, /aria-label="[A-Z][^"]+"/.test(tag)]).toEqual([id, true])
    }
    expect(app).toContain('localStorage.getItem("cg-hide-activity") !== "false"')
  })
})
