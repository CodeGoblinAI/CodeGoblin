import { expect } from "bun:test"
import { Effect, Layer } from "effect"
import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import { streamText } from "ai"
import { fetchWithImageInputFallback } from "../../src/provider/image-input-fallback"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.empty)
const rejection =
  "Message 27 of 30 in this request (role user) carries an image, and the selected model route accepts text only."
const image = { type: "image_url", image_url: { url: "data:image/png;base64,aGVsbG8=" } }
const payload = {
  model: "glm-5.3-flash-uncensored",
  stream: true,
  max_tokens: 123,
  reasoning_effort: "low",
  tool_choice: "auto",
  tools: [{ type: "function", function: { name: "read", parameters: { type: "object" } } }],
  messages: [
    { role: "user", content: [{ type: "text", text: "Earlier attachment" }, image] },
    {
      role: "assistant",
      content: "Earlier answer",
      tool_calls: [{ id: "call_1", type: "function", function: { name: "read", arguments: "{}" } }],
    },
    { role: "tool", tool_call_id: "call_1", content: "Saved result" },
    { role: "user", content: "Continue this conversation without looking at the image." },
  ],
}

function gateway(reply: (index: number) => Response) {
  const calls: { body: string; headers: Headers }[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      calls.push({ body: await request.text(), headers: request.headers })
      return reply(calls.length)
    },
  })
  return { server, calls, url: new URL("/v1/chat/completions", server.url) }
}

it.live(
  "retries rejected historical images without changing text, tools, model, credentials or the original history",
  () =>
    Effect.gen(function* () {
      const local = gateway((index) =>
        index === 1 ? Response.json({ error: { message: rejection } }, { status: 400 }) : new Response("CONTINUED"),
      )
      using server = local.server
      const body = JSON.stringify(payload)
      const headers = new Headers({
        authorization: "Bearer test-only",
        "x-canary": "unchanged",
        "content-length": String(Buffer.byteLength(body)),
      })
      const response = yield* Effect.promise(() =>
        fetchWithImageInputFallback(fetch, local.url, { method: "POST", body, headers }),
      )
      expect(yield* Effect.promise(() => response.text())).toBe("CONTINUED")
      expect(local.calls).toHaveLength(2)
      expect(local.calls[0].body).toBe(body)
      const retried = JSON.parse(local.calls[1].body)
      expect(retried).toEqual({
        ...payload,
        messages: [
          {
            ...payload.messages[0],
            content: [
              { type: "text", text: "Earlier attachment" },
              { type: "text", text: expect.stringContaining("Do not guess its contents") },
            ],
          },
          ...payload.messages.slice(1),
        ],
      })
      expect(local.calls[1].headers.get("authorization")).toBe("Bearer test-only")
      expect(local.calls[1].headers.get("x-canary")).toBe("unchanged")
      expect(Number(local.calls[1].headers.get("content-length"))).toBe(Buffer.byteLength(local.calls[1].body))
      expect(headers.get("content-length")).toBe(String(Buffer.byteLength(body)))
      expect(JSON.stringify(payload)).toBe(body)
    }),
)

it.live("successful image requests and response streams pass through unchanged", () =>
  Effect.gen(function* () {
    const local = gateway(() => new Response("data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } }))
    using server = local.server
    const body = JSON.stringify(payload)
    const response = yield* Effect.promise(() =>
      fetchWithImageInputFallback(fetch, local.url, { method: "POST", body }),
    )
    expect(local.calls).toHaveLength(1)
    expect(local.calls[0].body).toBe(body)
    expect(response.headers.get("content-type")).toBe("text/event-stream")
    expect(yield* Effect.promise(() => response.text())).toBe("data: [DONE]\n\n")
  }),
)

for (const status of [401, 403, 429, 500])
  it.live(`does not retry HTTP ${status} even with similar error text`, () =>
    Effect.gen(function* () {
      const local = gateway(() => Response.json({ error: { message: rejection } }, { status }))
      using server = local.server
      const response = yield* Effect.promise(() =>
        fetchWithImageInputFallback(fetch, local.url, { method: "POST", body: JSON.stringify(payload) }),
      )
      expect(response.status).toBe(status)
      expect(local.calls).toHaveLength(1)
      expect(yield* Effect.promise(() => response.json())).toEqual({ error: { message: rejection } })
    }),
  )

for (const error of ["Image violates content policy", "Invalid image format", "Invalid API key", "Request too large"])
  it.live(`does not hide unrelated rejection: ${error}`, () =>
    Effect.gen(function* () {
      const local = gateway(() => Response.json({ error: { message: error } }, { status: 400 }))
      using server = local.server
      const response = yield* Effect.promise(() =>
        fetchWithImageInputFallback(fetch, local.url, { method: "POST", body: JSON.stringify(payload) }),
      )
      expect(local.calls).toHaveLength(1)
      expect(yield* Effect.promise(() => response.json())).toEqual({ error: { message: error } })
    }),
  )

it.live("never retries more than once", () =>
  Effect.gen(function* () {
    const local = gateway(() => Response.json({ message: rejection }, { status: 400 }))
    using server = local.server
    const response = yield* Effect.promise(() =>
      fetchWithImageInputFallback(fetch, local.url, { method: "POST", body: JSON.stringify(payload) }),
    )
    expect(response.status).toBe(400)
    expect(local.calls).toHaveLength(2)
  }),
)

it.live("image-only prompts get a non-empty limitation notice, while other media is preserved", () =>
  Effect.gen(function* () {
    const local = gateway((index) =>
      index === 1 ? Response.json({ message: rejection }, { status: 400 }) : new Response("OK"),
    )
    using server = local.server
    const audio = { type: "input_audio", input_audio: { format: "wav", data: "fixture" } }
    const body = JSON.stringify({ model: payload.model, messages: [{ role: "user", content: [image, audio] }] })
    yield* Effect.promise(() => fetchWithImageInputFallback(fetch, local.url, { method: "POST", body }))
    expect(JSON.parse(local.calls[1].body).messages[0].content).toEqual([
      { type: "text", text: expect.stringContaining("cannot view the image") },
      audio,
    ])
  }),
)

for (const body of [
  "not json",
  JSON.stringify({ model: payload.model, messages: [{ role: "user", content: "No image" }] }),
])
  it.live(`does not retry when there are no removable image parts: ${body.slice(0, 12)}`, () =>
    Effect.gen(function* () {
      const local = gateway(() => Response.json({ error: { message: rejection } }, { status: 400 }))
      using server = local.server
      const response = yield* Effect.promise(() =>
        fetchWithImageInputFallback(fetch, local.url, { method: "POST", body }),
      )
      expect(response.status).toBe(400)
      expect(local.calls).toHaveLength(1)
    }),
  )

it.live("preserves non-JSON error bodies and non-chat endpoints", () =>
  Effect.gen(function* () {
    const local = gateway(() => new Response(rejection, { status: 400 }))
    using server = local.server
    const response = yield* Effect.promise(() =>
      fetchWithImageInputFallback(fetch, local.url, { method: "POST", body: JSON.stringify(payload) }),
    )
    expect(yield* Effect.promise(() => response.text())).toBe(rejection)
    const other = yield* Effect.promise(() =>
      fetchWithImageInputFallback(fetch, new URL("/v1/embeddings", server.url), {
        method: "POST",
        body: JSON.stringify(payload),
      }),
    )
    expect(other.status).toBe(400)
    expect(local.calls).toHaveLength(2)
  }),
)

it.live("actual SDK streaming continues after the image rejection", () =>
  Effect.gen(function* () {
    const local = gateway((index) =>
      index === 1
        ? Response.json({ error: { message: rejection } }, { status: 400 })
        : new Response(
            `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: "CONTINUED_WITHOUT_IMAGE" }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
            { headers: { "content-type": "text/event-stream" } },
          ),
    )
    using server = local.server
    const result = streamText({
      model: createOpenAICompatible({
        name: "fixture",
        apiKey: "test-only",
        baseURL: new URL("/v1", server.url).href,
        fetch: Object.assign(
          (input: RequestInfo | URL, init?: RequestInit) => fetchWithImageInputFallback(fetch, input, init),
          { preconnect: fetch.preconnect },
        ),
      }).chatModel(payload.model),
      messages: [
        { role: "user", content: [{ type: "image", image: new URL("data:image/png;base64,aGVsbG8=") }] },
        { role: "assistant", content: "Earlier reply" },
        { role: "user", content: "Continue the text conversation" },
      ],
      maxRetries: 0,
    })
    expect(yield* Effect.promise(() => result.text)).toBe("CONTINUED_WITHOUT_IMAGE")
    expect(local.calls).toHaveLength(2)
  }),
)
