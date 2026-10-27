import { expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"

const source = fs.readFileSync(path.join(import.meta.dir, "../src/web/app.js"), "utf8")
// Session navigation is idle here; its own test covers the pending guard.
const sessionNavigation = { pending: () => false }
const update = new Function("input", "sendBtn", "busy", "attachments", "sessionNavigation", source.slice(source.indexOf("function updateSendButton()"), source.indexOf("function renderAttached()")) + "; updateSendButton()") as
  (input: { style: { height: string }; value: string; scrollHeight: number }, button: { disabled: boolean }, busy: boolean, attachments: unknown[], navigation: typeof sessionNavigation) => void
const sized = (input: { style: { height: string }; value: string; scrollHeight: number }, button: { disabled: boolean }, busy: boolean, attachments: unknown[]) =>
  update(input, button, busy, attachments, sessionNavigation)

test("the actual composer sizing caps a long draft and shrinks after clear", () => {
  const input = { style: { height: "" }, value: "long draft", scrollHeight: 400 }
  const button = { disabled: true }
  sized(input, button, false, [])
  expect(input.style.height).toBe("156px")
  expect(button.disabled).toBe(false)
  input.value = ""
  input.scrollHeight = 32
  sized(input, button, false, [])
  expect(input.style.height).toBe("32px")
  expect(button.disabled).toBe(true)
})

test("Stop remains available with an empty multiline draft", () => {
  const button = { disabled: true }
  sized({ style: { height: "" }, value: "", scrollHeight: 32 }, button, true, [])
  expect(button.disabled).toBe(false)
})

test("the composer is multiline, labelled and documents its newline shortcut", () => {
  const page = fs.readFileSync(path.join(import.meta.dir, "../src/web/index.html"), "utf8")
  expect(page).toContain('<textarea id="input"')
  expect(page).toContain('aria-describedby="composer-hint"')
  expect(page).toContain("Shift+Enter for a new line")
  expect(source).toContain('if (event.key === "Enter" && event.shiftKey) return')
})
