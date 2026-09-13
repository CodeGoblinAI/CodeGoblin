import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { systemPrompt } from "../src/core/system-prompt"

describe("what the model is told first", () => {
  test("on Windows, that commands run in cmd.exe and what that means", () => {
    const text = systemPrompt("terminal", "win32")
    expect(text).toContain("cmd.exe")
    expect(text).toContain("&&")
    expect(text).toContain("rather than using node -e")
  })

  test("elsewhere, that commands run in sh, and nothing about cmd.exe", () => {
    const text = systemPrompt("terminal", "linux")
    expect(text).toContain("/bin/sh")
    expect(text).not.toContain("cmd.exe")
  })

  test("the terminal and the browser are told the same things, bar where they are", () => {
    const terminal = systemPrompt("terminal", "win32")
    const browser = systemPrompt("browser", "win32")
    expect(terminal).toContain("working in a terminal")
    expect(browser).toContain("working in the user's browser")
    expect(terminal.split("\n").slice(1)).toEqual(browser.split("\n").slice(1))
    for (const text of [terminal, browser]) {
      expect(text).toContain("A refusal is an answer")
      expect(text).toContain("skill to load")
      expect(text).toContain("make the change first")
    }
  })

  test("both surfaces use it, rather than keeping their own", () => {
    // The browser had a two-sentence prompt of its own for months; this is
    // what stops a surface drifting away again.
    const root = path.join(import.meta.dir, "..", "src")
    expect(fs.readFileSync(path.join(root, "tui", "app.ts"), "utf8")).toContain('systemPrompt("terminal")')
    expect(fs.readFileSync(path.join(root, "web", "serve.ts"), "utf8")).toContain('systemPrompt("browser")')
  })
})
