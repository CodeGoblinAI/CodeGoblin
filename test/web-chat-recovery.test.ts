import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"

// The browser serves a plain script. Exercise its actual functions, as the
// mention tests do, without introducing a separate copy of their decisions.
const source = fs.readFileSync(path.join(import.meta.dir, "../src/web/app.js"), "utf8")
const failure = new Function(source.slice(source.indexOf("function chatFailure("), source.indexOf("/** Keep both drafts")) + "; return chatFailure")() as
  (aborted: boolean, started: boolean) => { message: string; recover: boolean }

describe("Web chat transport failures", () => {
  test("an unreachable server is not called a user cancellation and permits draft recovery", () => {
    const result = failure(false, false)
    expect(result.message).toContain("Could not reach")
    expect(result.message).toContain("review /resume")
    expect(result.message).not.toContain("stopped")
    expect(result.recover).toBe(true)
  })

  test("a broken accepted stream warns about incomplete output and prior tool execution", () => {
    const result = failure(false, true)
    expect(result.message).toContain("Connection interrupted")
    expect(result.message).toContain("tools may already have run")
    expect(result.recover).toBe(false)
  })

  test("explicit Stop remains a stop before or after response headers", () => {
    for (const started of [false, true]) {
      expect(failure(true, started)).toEqual({ message: "_stopped_", recover: false })
    }
  })
})
