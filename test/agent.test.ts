import { afterEach, describe, expect, test } from "bun:test"
import { runAgent, type AgentEvent } from "../src/core/agent"
import type { Provider } from "../src/core/providers"

/**
 * The agent loop, with the provider replaced.
 *
 * Nothing here reaches the network: fetch is swapped for a queue of canned
 * server-sent event streams, one per turn, so a loop that would otherwise
 * need a paid model and a tolerance for its mood becomes ordinary to test.
 */
const provider: Provider = {
  id: "test",
  label: "Test",
  baseUrl: "https://example.invalid/v1/chat/completions",
  models: [{ id: "test-model", label: "Test", contextWindow: 128000 }],
}

const NEWLINE = String.fromCharCode(10)

/** One SSE body from the chunks a provider would have streamed. */
function stream(...chunks: unknown[]): Response {
  const text =
    chunks.map((chunk) => "data: " + JSON.stringify(chunk)).join(NEWLINE + NEWLINE) +
    NEWLINE + NEWLINE + "data: [DONE]" + NEWLINE + NEWLINE
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(text))
        controller.close()
      },
    }),
    { status: 200 },
  )
}

const asksForATool = () =>
  stream({
    choices: [
      {
        delta: {
          tool_calls: [
            { index: 0, id: "call-1", function: { name: "list_files", arguments: '{"path":"."}' } },
          ],
        },
      },
    ],
  })

const answers = (text: string) => stream({ choices: [{ delta: { content: text } }] })

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

/** Serve the given responses in order, repeating the last one forever. */
function serve(...responses: (() => Response)[]) {
  let index = 0
  globalThis.fetch = (async () => {
    const make = responses[Math.min(index, responses.length - 1)]!
    index++
    return make()
  }) as typeof fetch

  return () => index
}

async function collect(maxTurns: number): Promise<AgentEvent[]> {
  const events: AgentEvent[] = []
  for await (const event of runAgent({
    provider,
    modelId: "test-model",
    apiKey: "not-a-real-key",
    messages: [{ role: "user", content: "go" }],
    root: process.cwd(),
    maxTurns,
  })) {
    events.push(event)
  }
  return events
}

describe("the turn limit", () => {
  test("a model that never stops calling tools ends with a limit event", async () => {
    const requests = serve(asksForATool)
    const events = await collect(3)

    const limit = events.find((event) => event.type === "limit")
    expect(limit).toBeDefined()
    expect(limit && "turns" in limit ? limit.turns : 0).toBe(3)
    // It asked three times and then gave up, rather than looping forever.
    expect(requests()).toBe(3)
  })

  test("the limit comes before turn_end, so a surface sees why it ended", async () => {
    serve(asksForATool)
    const types = (await collect(2)).map((event) => event.type)
    expect(types.indexOf("limit")).toBeLessThan(types.indexOf("turn_end"))
    expect(types[types.length - 1]).toBe("turn_end")
  })

  test("an answer that finishes on its own says nothing about limits", async () => {
    serve(() => answers("all done"))
    const events = await collect(8)

    expect(events.some((event) => event.type === "limit")).toBe(false)
    expect(events.some((event) => event.type === "text")).toBe(true)
    expect(events[events.length - 1]!.type).toBe("turn_end")
  })

  test("a turn that uses a tool and then answers is not a limit either", async () => {
    serve(asksForATool, () => answers("found them"))
    const events = await collect(8)

    expect(events.some((event) => event.type === "tool_start")).toBe(true)
    expect(events.some((event) => event.type === "tool_end")).toBe(true)
    expect(events.some((event) => event.type === "limit")).toBe(false)
  })
})

describe("the loop itself", () => {
  test("a refusal from the provider is raised, not swallowed", async () => {
    globalThis.fetch = (async () => new Response("no key for you", { status: 401 })) as typeof fetch
    await expect(collect(2)).rejects.toThrow(/401/)
  })

  test("an aborted turn stops asking", async () => {
    const requests = serve(asksForATool)
    const stopping = new AbortController()
    const events: AgentEvent[] = []

    for await (const event of runAgent({
      provider,
      modelId: "test-model",
      apiKey: "not-a-real-key",
      messages: [{ role: "user", content: "go" }],
      root: process.cwd(),
      maxTurns: 8,
      signal: stopping.signal,
    })) {
      events.push(event)
      if (event.type === "tool_end") stopping.abort()
    }

    expect(requests()).toBeLessThan(8)
    expect(events.some((event) => event.type === "limit")).toBe(false)
  })
})
