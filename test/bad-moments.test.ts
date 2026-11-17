import { afterEach, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { closeOpenCalls, runAgent, type AgentEvent, type Message } from "../src/core/agent"
import { providerError } from "../src/core/provider-error"
import { runTool } from "../src/core/tools"
import type { Provider } from "../src/core/providers"

/**
 * What the app does when a provider or a model misbehaves. Each of these once ended with nothing on screen,
 * a misleading error, or a conversation that could not be continued.
 */
const provider: Provider = { id: "test", label: "Test", baseUrl: "https://example.invalid/v1/chat/completions", models: [{ id: "m", label: "M", contextWindow: 128000 }] }
const NL = String.fromCharCode(10)
const sse = (...chunks: unknown[]) => new Response(chunks.map((chunk) => "data: " + JSON.stringify(chunk)).join(NL + NL) + NL + NL + "data: [DONE]" + NL + NL)
const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch })
const root = fs.mkdtempSync(path.join(os.tmpdir(), "cg-bad-moments-"))

async function play(replies: (() => Response)[], messages: Message[] = [{ role: "user", content: "go" }]) {
  const sent: { messages: Message[] }[] = []
  let index = 0
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => { sent.push(JSON.parse(String(init?.body))); return replies[Math.min(index++, replies.length - 1)]!() }) as typeof fetch
  const events: AgentEvent[] = []
  let error = ""
  try { for await (const event of runAgent({ provider, modelId: "m", apiKey: "k", messages, root, maxTurns: 4 })) events.push(event) } catch (caught) { error = String(caught instanceof Error ? caught.message : caught) }
  return { events, error, sent, text: events.filter((event) => event.type === "text").map((event) => (event as { delta: string }).delta).join(""), results: events.filter((event) => event.type === "tool_end").map((event) => (event as { result: string }).result) }
}

test("an error sent inside the stream is an error, not an answer that ends with nothing", async () => {
  const played = await play([() => sse({ error: { message: "upstream model overloaded", code: 529 } })])
  expect(played.error).toBe("Test stopped part way through its answer: upstream model overloaded")
  expect((await play([() => sse({ choices: [{ delta: { content: "half an ans" } }] }, { error: "connection reset" })])).error).toContain("connection reset")
})

/** A stream that sends what it is given and then nothing more, ever, without closing. */
const silentAfter = (...chunks: unknown[]) => () => new Response(new ReadableStream({
  start(controller) { for (const chunk of chunks) controller.enqueue(new TextEncoder().encode("data: " + JSON.stringify(chunk) + NL + NL)) },
}))

test("a provider that goes silent part way through is given up on, saying so, and said to be quiet first", async () => {
  process.env.CG_STALL_MS = "1200"
  try {
    const started = Date.now()
    const played = await play([silentAfter({ choices: [{ delta: { content: "half an ans" } }] })])
    expect(Date.now() - started).toBeLessThan(5000)
    expect(played.error).toContain("Test sent nothing for 1 second, so CG-Next stopped waiting for it")
    expect(played.text).toBe("half an ans")
    // Before giving up, the surfaces were told how long it had been silent.
    const quiet = played.events.filter((event) => event.type === "quiet").map((event) => (event as { ms: number }).ms)
    expect(quiet.length).toBeGreaterThan(1)
    expect(quiet).toEqual([...quiet].sort((a, b) => a - b))
  } finally {
    delete process.env.CG_STALL_MS
  }
})

test("a provider that never answers at all is asked again, then given up on", async () => {
  process.env.CG_STALL_MS = "600"
  try {
    let asked = 0
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      asked++
      // Never answers, but does end when it is told to.
      return new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))))
    }) as typeof fetch
    const events: AgentEvent[] = []
    let error = ""
    try { for await (const event of runAgent({ provider, modelId: "m", apiKey: "k", messages: [{ role: "user", content: "go" }], root, maxTurns: 2, retryWaits: [10] })) events.push(event) } catch (caught) { error = String(caught instanceof Error ? caught.message : caught) }
    expect(asked).toBe(2)
    expect(events.some((event) => event.type === "retry" && (event as { reason: string }).reason === "no reply")).toBe(true)
    expect(error).toContain("sent nothing for")
  } finally {
    delete process.env.CG_STALL_MS
  }
})

test("a model on this machine is never given up on: reading a long prompt on a CPU sends nothing for minutes", async () => {
  process.env.CG_STALL_MS = "300"
  try {
    const local: Provider = { ...provider, id: "llama", local: true }
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      // The server is asked which models it has first.
      if (!init?.method || init.method === "GET") return Response.json({ data: [{ id: "m" }] })
      await Bun.sleep(1200)
      return sse({ choices: [{ delta: { content: "read it all" } }] })
    }) as typeof fetch
    const events: AgentEvent[] = []
    for await (const event of runAgent({ provider: local, modelId: "m", apiKey: "k", messages: [{ role: "user", content: "go" }], root, maxTurns: 2 })) events.push(event)
    expect(events.filter((event) => event.type === "text").map((event) => (event as { delta: string }).delta).join("")).toBe("read it all")
    const quiet = events.filter((event) => event.type === "quiet") as { ms: number; endless?: boolean }[]
    expect(quiet.length).toBeGreaterThan(0)
    expect(quiet.every((event) => event.endless === true)).toBe(true)
  } finally {
    delete process.env.CG_STALL_MS
  }
})

test("a message larger than the model can read is not sent, and does not jam the conversation", async () => {
  // A provider that refuses a request over its window, as real ones do (about 4 characters a token).
  const WINDOW = 20000
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    const body = String(init?.body)
    if (body.length / 4 > WINDOW) return new Response('{"error":{"message":"This model\'s maximum context length is 20000 tokens."}}', { status: 400 })
    return sse({ choices: [{ delta: { content: "fine" } }] })
  }) as typeof fetch
  const messages: Message[] = [{ role: "user", content: "hello" }, { role: "assistant", content: "hi" }, { role: "user", content: "log line\n".repeat(10000) }]
  let error = ""
  try { for await (const _ of runAgent({ provider, modelId: "m", apiKey: "k", messages, root, contextWindow: WINDOW, maxTurns: 2 })) {} } catch (caught) { error = String(caught instanceof Error ? caught.message : caught) }
  expect(error).toContain("was not sent")
  expect(error).toContain("@")
  // The conversation is as it was before it, so the next message goes through.
  expect(messages.map((message) => message.content)).toEqual(["hello", "hi"])
  messages.push({ role: "user", content: "a short question" })
  const text: string[] = []
  for await (const event of runAgent({ provider, modelId: "m", apiKey: "k", messages, root, contextWindow: WINDOW, maxTurns: 2 })) if (event.type === "text") text.push(event.delta)
  expect(text.join("")).toBe("fine")
  // Text in a script that takes a token or more a character is measured as that, not as a quarter of one.
  const wide: Message[] = [{ role: "user", content: "日本語".repeat(5000) }]
  let wideError = ""
  try { for await (const _ of runAgent({ provider, modelId: "m", apiKey: "k", messages: wide, root, contextWindow: WINDOW, maxTurns: 2 })) {} } catch (caught) { wideError = String(caught instanceof Error ? caught.message : caught) }
  expect(wideError).toContain("was not sent")
})

test("an answer with nothing in it says so", async () => {
  const messages: Message[] = [{ role: "user", content: "go" }]
  const played = await play([() => sse({ choices: [{ delta: {} }] })], messages)
  expect(played.text).toContain("The model returned an empty answer")
  // And what is saved is not an empty message, which some providers refuse on the next request.
  expect(messages.at(-1)).toMatchObject({ role: "assistant" })
  expect(messages.at(-1)!.content.trim().length).toBeGreaterThan(0)
})

test("arguments cut off or malformed are named as that, and nothing is run", async () => {
  const half = () => sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "write_file", arguments: '{"path":"half.txt","content":"ha' } }] } }] })
  const played = await play([half, () => sse({ choices: [{ delta: { content: "ok" } }] })])
  expect(played.results[0]).toContain("the arguments for write_file were not valid JSON")
  expect(played.results[0]).toContain("Nothing was run")
  expect(fs.existsSync(path.join(root, "half.txt"))).toBe(false)
})

test("a missing or mistyped argument is named, in the tool's own words for it", async () => {
  expect(await runTool("read_file", {}, root)).toBe('error: read_file needs "path" (a string), and it was not given')
  expect(await runTool("read_file", { path: 42 }, root)).toBe('error: read_file takes "path" as a string, and was given a number')
  expect(await runTool("shell", { command: "echo ok", timeout_ms: "soon" }, root)).toBe('error: shell takes "timeout_ms" as a number, and was given a string')
  expect(await runTool("write_file", { path: "x.txt" }, root)).toContain('needs "content"')
})

test("a result that answers no call is dropped before it is sent; an unanswered call is closed", () => {
  const messages: Message[] = [
    { role: "tool", tool_call_id: "ghost", content: "left over" },
    { role: "user", content: "hi" },
    { role: "assistant", content: "", tool_calls: [{ id: "a", type: "function", function: { name: "read_file", arguments: "{}" } }, { id: "b", type: "function", function: { name: "read_file", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "a", content: "one" },
    { role: "tool", tool_call_id: "stray", content: "not asked for" },
    { role: "user", content: "and now?" },
  ]
  closeOpenCalls(messages)
  expect(messages.map((message) => message.role + (message.tool_call_id ? ":" + message.tool_call_id : ""))).toEqual(["user", "assistant", "tool:a", "tool:b", "user"])
})

test("a refusal from the provider says what happened and what to do, and keeps the status", () => {
  const p = { id: "zai", label: "Z.ai" }
  expect(providerError(p, 401, '{"error":{"message":"Incorrect API key provided"}}')).toBe("Z.ai refused the key (returned 401): Incorrect API key provided. /connect zai stores a new one.")
  expect(providerError(p, 402, '{"error":{"message":"Insufficient Balance"}}')).toContain("run out of credit (returned 402): Insufficient Balance.")
  expect(providerError(p, 400, '{"error":{"message":"This model\'s maximum context length is 131072 tokens."}}')).toContain("The conversation is too long for this model (Z.ai returned 400)")
  expect(providerError(p, 400, '{"error":{"message":"maximum context length"}}')).toContain("/compact")
  expect(providerError(p, 429, '{"message":"slow down"}')).toContain("returned 429): slow down.")
  expect(providerError(p, 404, '{"error":{"message":"The model `x` does not exist"}}')).toContain("has no such model (returned 404)")
  // A page from a proxy: its heading, never the markup.
  const page = providerError(p, 502, "<html><head><title>502 Bad Gateway</title></head><body><h1>502</h1><p>nginx</p></body></html>")
  expect(page).toBe("Z.ai is having trouble (returned 502): 502 Bad Gateway. It was tried again and still failed; try once more in a moment.")
  expect(providerError(p, 503, "")).toContain("returned 503)")
  expect(providerError(p, 418, "teapot")).toBe("Z.ai returned 418: teapot.")
})
