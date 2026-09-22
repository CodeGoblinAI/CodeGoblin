import { expect, test } from "bun:test"
import { localProvider } from "../src/core/local-provider"
import { verifyLocalModel } from "../src/core/local-provider"
import { runAgent } from "../src/core/agent"

test("local provider is opt-in, loopback-only, uncredentialed and chat-only by default", () => {
  expect(localProvider({})).toBeUndefined()
  for (const url of ["https://example.com/v1", "http://example.com/v1", "http://user:pass@localhost/v1"]) {
    expect(() => localProvider({ CODEGOBLIN_LOCAL_URL: url, CODEGOBLIN_LOCAL_MODEL: "test" })).toThrow()
  }
  const provider = localProvider({ CODEGOBLIN_LOCAL_URL: "http://127.0.0.1:8787/v1", CODEGOBLIN_LOCAL_MODEL: "org/model" })!
  expect(provider.baseUrl).toBe("http://127.0.0.1:8787/v1/chat/completions")
  expect(provider.auth!("secret")).toEqual({})
  expect(provider.localTools).toBe(false)
  expect(localProvider({ CODEGOBLIN_LOCAL_URL: "http://127.0.0.1:8787/v1", CODEGOBLIN_LOCAL_MODEL: "test", CODEGOBLIN_LOCAL_THINKING: "0" })?.localThinking).toBe(false)
})

test("a different model on the configured port is rejected", async () => {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ data: [{ id: "different-model" }] }) })
  try {
    const provider = localProvider({ CODEGOBLIN_LOCAL_URL: `http://127.0.0.1:${server.port}/v1`, CODEGOBLIN_LOCAL_MODEL: "expected" })!
    await expect(verifyLocalModel(provider, "expected")).rejects.toThrow("Local model mismatch")
  } finally { server.stop(true) }
})

test("local chat sends a lean prompt and no credentials or tools over the actual wire", async () => {
  let body: Record<string, unknown> = {}
  let authorization: string | null = "unset"
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    if (request.method === "GET") return Response.json({ data: [{ id: "test" }] })
    authorization = request.headers.get("authorization")
    body = await request.json() as Record<string, unknown>
    return new Response('data: {"choices":[{"delta":{"content":"hello"}}]}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } })
  } })
  try {
    const provider = localProvider({ CODEGOBLIN_LOCAL_URL: `http://127.0.0.1:${server.port}/v1`, CODEGOBLIN_LOCAL_MODEL: "test", CODEGOBLIN_LOCAL_THINKING: "0" })!
    const events = []
    for await (const event of runAgent({ provider, modelId: "test", apiKey: "must-not-leak", root: process.cwd(), messages: [{ role: "system", content: "large agent instructions" }, { role: "user", content: "hi" }] })) events.push(event)
    expect(authorization).toBeNull()
    expect(body.tools).toBeUndefined()
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: false })
    expect(JSON.stringify(body.messages)).not.toContain("large agent instructions")
    expect(events).toContainEqual({ type: "text", delta: "hello" })
  } finally { server.stop(true) }
})
