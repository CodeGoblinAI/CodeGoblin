import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { runAgent, type AgentEvent } from "../src/core/agent"
import { runCommand } from "../src/core/commands"
import type { Provider } from "../src/core/providers"

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
    expect(text).toContain("subagents: !profile?.tools && (boost || boostOnce || subagents.running().length) ? subagents : undefined")
  })

  test("the web server passes them only when the page asked for boost", () => {
    const text = fs.readFileSync(path.join(root, "web", "serve.ts"), "utf8")
    expect(text).toContain("subagents: !profile?.tools && (body.boost === true || subagents.running().length) ? subagents : undefined")
  })
})

describe("a subagent tool called when subagents are off", () => {
  const provider: Provider = {
    id: "test",
    label: "Test",
    baseUrl: "https://example.invalid/v1/chat/completions",
    models: [{ id: "test-model", label: "Test", contextWindow: 128000 }],
  }
  const NEWLINE = String.fromCharCode(10)
  const sse = (delta: Record<string, unknown>) =>
    new Response("data: " + JSON.stringify({ choices: [{ delta }] }) + NEWLINE + NEWLINE + "data: [DONE]" + NEWLINE + NEWLINE)

  const realFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = realFetch
  })

  test("says why, and that earlier subagent results were real", async () => {
    // Seen with the real model: after a boosted request it called task again
    // from memory, got "unknown tool", and told the user its earlier - genuine -
    // subagent report should not be trusted.
    let turn = 0
    globalThis.fetch = (async () =>
      turn++ === 0
        ? sse({ tool_calls: [{ index: 0, id: "t1", function: { name: "task", arguments: JSON.stringify({ agent: "explore", description: "x", prompt: "x" }) } }] })
        : sse({ content: "done" })) as unknown as typeof fetch

    const events: AgentEvent[] = []
    for await (const event of runAgent({
      provider,
      modelId: "test-model",
      apiKey: "not-a-real-key",
      messages: [{ role: "user", content: "go" }],
      root: process.cwd(),
    })) {
      events.push(event)
    }
    const ended = events.find((event) => event.type === "tool_end") as { result: string }
    expect(ended.result).toContain("/boost")
    expect(ended.result).toContain("were real")
    expect(ended.result).not.toContain("unknown tool")
  })
})
