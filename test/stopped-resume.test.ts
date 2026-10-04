import { expect, test } from "bun:test"
import { runAgent, type Message } from "../src/core/agent"
import { Permissions } from "../src/core/permission"
import { create, save, load } from "../src/core/sessions"
import type { Provider } from "../src/core/providers"

test("an aborted actual SSE response stores partial text/marker and resume forwards no metadata fields", async () => {
  const requests: { messages: Record<string, unknown>[] }[] = []
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const body = await request.json() as { messages: Record<string, unknown>[] }
    requests.push(body)
    return new Response(new ReadableStream({ start(stream) {
      stream.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"unfinished text"}}]}\n\n'))
      if (requests.length > 1) stream.close()
    } }), { headers: { "content-type": "text/event-stream" } })
  } })
  const provider: Provider = { id: "fixture", label: "fixture", baseUrl: "http://127.0.0.1:" + server.port, models: [] }
  const messages: Message[] = [{ role: "user", content: "slow" }]
  const stopping = new AbortController()
  try {
    try {
      for await (const event of runAgent({ provider, modelId: "fixture", apiKey: "", messages, signal: stopping.signal })) {
        if (event.type === "text") stopping.abort()
      }
    } catch { expect(stopping.signal.aborted).toBe(true) }
    expect(messages.at(-1)).toEqual({ role: "assistant", content: "unfinished text", stopped: true })
    const session = create("fixture", "fixture")
    session.messages = messages
    await save(session)
    const resumed = (await load(session.id))!
    expect(resumed.messages.at(-1)).toEqual(messages.at(-1))
    resumed.messages.push({ role: "user", content: "continue" })
    for await (const _ of runAgent({ provider, modelId: "fixture", apiKey: "", messages: resumed.messages })) { /* drain */ }
    expect(requests[1]!.messages.some(message => message.content === "unfinished text\n\n[This answer was stopped by the user.]")).toBe(true)
    expect(requests[1]!.messages.some(message => "stopped" in message)).toBe(false)
  } finally { await server.stop(true) }
})

test("CLI cancellation discards proposed tool calls, but preserves its streamed answer", async () => {
  const stopping = new AbortController()
  const messages: Message[] = [{ role: "user", content: "stop" }]
  for await (const _ of runAgent({
    provider: { id: "codex", label: "Codex", cli: "codex", models: [] }, modelId: "fixture", apiKey: "", messages, signal: stopping.signal,
    completion: async function* () {
      yield { type: "text", delta: "CLI partial" }
      stopping.abort()
      yield { type: "calls", calls: [{ id: "never-executed", name: "write_file", args: '{"path":"never.txt","content":"not executed"}' }] }
    },
  })) { /* drain */ }
  expect(messages.at(-1)).toEqual({ role: "assistant", content: "CLI partial", stopped: true })
  expect(messages.some(message => message.tool_calls?.length)).toBe(false)
})

test("stopping at approval closes saved tool calls before a single stopped marker", async () => {
  const stopping = new AbortController()
  const messages: Message[] = [{ role: "user", content: "stop" }]
  const permissions = new Permissions(async () => { stopping.abort(); return "reject" })
  for await (const _ of runAgent({
    provider: { id: "codex", label: "Codex", cli: "codex", models: [] }, modelId: "fixture", apiKey: "", messages, signal: stopping.signal, permissions,
    completion: async function* () { yield { type: "calls", calls: [{ id: "approval-stop", name: "write_file", args: '{"path":"never.txt","content":"not executed"}' }] } },
  })) { /* drain */ }
  expect(messages.filter(message => message.stopped)).toHaveLength(1)
  expect(messages.some(message => message.role === "tool" && message.tool_call_id === "approval-stop")).toBe(true)
  expect(messages.at(-1)).toEqual({ role: "assistant", content: "", stopped: true })
})
