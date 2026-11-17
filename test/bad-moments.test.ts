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
