import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { runCommand } from "../src/core/commands"

/**
 * Subagents are opt-in, the way Antigravity's /boost is: they cost a second
 * conversation's tokens and most tasks do not need them, so the model is not
 * offered them unless the user asks.
 */
describe("/boost", () => {
  test("with a request, boosts that request", () => {
    expect(runCommand("/boost untangle the race in the scheduler")).toEqual({ kind: "boost", text: "untangle the race in the scheduler" })
  })

  test("on its own, switches boost for the session", () => {
    expect(runCommand("/boost")).toEqual({ kind: "boost", text: undefined })
  })
})

describe("neither surface offers subagents unless boosted", () => {
  const root = path.join(import.meta.dir, "..", "src")

  test("the terminal passes them only with boost, or while some are still out", () => {
    const text = fs.readFileSync(path.join(root, "tui", "app.ts"), "utf8")
    expect(text).toContain("subagents: boost || boostOnce || subagents.running().length ? subagents : undefined")
  })

  test("the web server passes them only when the page asked for boost", () => {
    const text = fs.readFileSync(path.join(root, "web", "serve.ts"), "utf8")
    expect(text).toContain("subagents: body.boost === true || subagents.running().length ? subagents : undefined")
  })
})
