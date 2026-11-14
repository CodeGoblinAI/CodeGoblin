import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import * as ModelsDev from "@codegoblin/core/models-dev"
import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import { jsonSchema, stepCountIs, streamText, tool } from "ai"
import { fromModelsDevProvider } from "../../src/provider/provider"
import * as ProviderTransform from "../../src/provider/transform"
import { refuselessCatalog, refuselessModels } from "../../src/provider/refuseless"
import fixture from "./fixtures/refuseless-models.json"

const image =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg=="

describe("Refuseless", () => {
  test("imports the complete public lineup with API prices and vision flags", () => {
    const models = refuselessModels(fixture.data)
    expect(Object.keys(models).sort()).toEqual(fixture.data.map((row) => row.id).sort())
    for (const row of fixture.data) {
      const model = Schema.decodeUnknownSync(ModelsDev.Model)(models[row.id])
      expect(model.cost).toEqual({
        input: row.pricing.input_per_m,
        output: row.pricing.output_per_m,
        cache_read: row.pricing.cached_input_per_m,
      })
      expect(model.limit.context).toBe(row.context_length)
      expect(model.attachment).toBe(row.vision)
      expect(model.modalities?.input).toEqual(row.vision ? ["text", "image"] : ["text"])
      expect(model.interleaved).toEqual({ field: "reasoning_content" })
    }
    expect(models["deepseek-v4.1-flash-abliterated-free"].cost?.input).toBe(0.12)
  })

  test("does not invent prices, limits or vision for incomplete rows", () => {
    const row = fixture.data[0]
    expect(refuselessModels([null, {}, { ...row, id: "" }, { ...row, pricing: undefined }])).toEqual({})
    for (const value of [-1, NaN, Infinity]) {
      expect(refuselessModels([{ ...row, pricing: { ...row.pricing, input_per_m: value } }])).toEqual({})
      expect(refuselessModels([{ ...row, context_length: value }])).toEqual({})
    }
    expect(refuselessModels([{ ...row, context_length: 0 }])).toEqual({})
    expect(refuselessModels([{ ...row, pricing: { ...row.pricing, currency: "EUR" } }])).toEqual({})
    expect(refuselessModels([{ ...row, vision: undefined }])[row.id].modalities?.input).toEqual(["text"])
  })

  test("accepts new ids, actual zero rates and long context pricing", () => {
    const models = refuselessModels([
      {
        ...fixture.data[0],
        id: "future-model",
        reasoning_efforts: [],
        pricing: {
          currency: "USD",
          input_per_m: 0,
          output_per_m: 0,
          long_context: { threshold: 200000, input_per_m: 2, output_per_m: 4, cached_input_per_m: 0.2 },
        },
      },
    ])
    expect(models["future-model"]).toMatchObject({
      name: "future-model",
      reasoning: false,
      cost: {
        input: 0,
        output: 0,
        tiers: [{ tier: { type: "context", size: 200000 }, input: 2, output: 4, cache_read: 0.2 }],
      },
    })
    Schema.decodeUnknownSync(ModelsDev.Model)(models["future-model"])
  })

  test("fetches public metadata without credentials and validates the provider", async () => {
    using server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(request) {
        expect(new URL(request.url).pathname).toBe("/v1/models")
        expect(request.headers.get("authorization")).toBeNull()
        return Response.json(fixture)
      },
    })
    const catalog = await refuselessCatalog((url, init) =>
      fetch(new URL(new URL(String(url)).pathname, server.url), init),
    )
    expect(catalog).toMatchObject({
      id: "refuseless",
      name: "Refuseless",
      env: ["REFUSELESS_API_KEY"],
      api: "https://api.refuseless.com/v1",
      npm: "@ai-sdk/openai-compatible",
    })
    Schema.decodeUnknownSync(ModelsDev.Provider)(catalog)
  })

  test("honors a live empty catalog but rejects corrupt or failed catalogs", async () => {
    expect((await refuselessCatalog(async () => Response.json({ object: "list", data: [] }))).models).toEqual({})
    await expect(refuselessCatalog(async () => new Response("unavailable", { status: 503 }))).rejects.toThrow(
      "HTTP 503",
    )
    await expect(refuselessCatalog(async () => Response.json({ data: fixture.data }))).rejects.toThrow()
    await expect(refuselessCatalog(async () => Response.json({ object: "list", data: [null, {}] }))).rejects.toThrow(
      "no valid priced models",
    )
  })

  test("snapshot registers every model and retains Experiential Labs", async () => {
    const snapshot = await Bun.file(new URL("../../models/api.json", import.meta.url)).json()
    const provider = Schema.decodeUnknownSync(ModelsDev.Provider)(snapshot.refuseless)
    expect(provider.models).toEqual(refuselessModels(fixture.data))
    expect(snapshot.explabs.models["glm-5.3-flash-uncensored"]).toBeDefined()
    expect(snapshot.openai).toBeDefined()
    expect(snapshot.anthropic).toBeDefined()
  })

  test.each(fixture.data.map((row) => [row.id, row.reasoning_efforts] as const))(
    "%s exposes only accepted reasoning variants",
    async (id, efforts) => {
      const catalog = await refuselessCatalog(async () => Response.json(fixture))
      const model = fromModelsDevProvider(catalog).models[id]
      expect(Object.keys(ProviderTransform.variants(model))).toEqual(efforts)
      expect(model.capabilities.input.image).toBe(fixture.data.find((row) => row.id === id)?.vision === true)
    },
  )

  test.each(fixture.data.map((row) => row.id))(
    "%s authenticates, streams reasoning, executes a tool and continues",
    async (id) => {
      const calls: unknown[] = []
      using server = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        async fetch(request) {
          expect(new URL(request.url).pathname).toBe("/v1/chat/completions")
          expect(request.headers.get("authorization")).toBe("Bearer local-test-key")
          const body = await request.json()
          calls.push(body)
          expect(body.model).toBe(id)
          expect(body.reasoning_effort).toBe("high")
          expect(body.stream_options).toEqual({ include_usage: true })
          if (fixture.data.find((row) => row.id === id)?.vision) {
            expect(body.messages[0].content).toContainEqual({
              type: "image_url",
              image_url: { url: image },
            })
          }
          const first = calls.length === 1
          if (!first) expect(body.messages).toContainEqual(expect.objectContaining({ role: "tool", content: "canary" }))
          const chunks = [
            { choices: [{ index: 0, delta: { reasoning_content: "Checking the fixture." }, finish_reason: null }] },
            {
              choices: [
                {
                  index: 0,
                  delta: first
                    ? {
                        tool_calls: [
                          { index: 0, id: "call_read", type: "function", function: { name: "read", arguments: "{}" } },
                        ],
                      }
                    : { content: "canary" },
                  finish_reason: null,
                },
              ],
            },
            {
              choices: [{ index: 0, delta: {}, finish_reason: first ? "tool_calls" : "stop" }],
              usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
            },
          ]
          return new Response(
            chunks
              .map(
                (chunk) =>
                  `data: ${JSON.stringify({ id: "test", object: "chat.completion.chunk", created: 1, model: id, ...chunk })}\n\n`,
              )
              .join("") + "data: [DONE]\n\n",
            { headers: { "content-type": "text/event-stream" } },
          )
        },
      })
      const provider = createOpenAICompatible({
        name: "refuseless",
        baseURL: `${server.url.origin}/v1`,
        apiKey: "local-test-key",
        includeUsage: true,
      })
      const result = streamText({
        model: provider.chatModel(id),
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "Read the fixture." },
              ...(fixture.data.find((row) => row.id === id)?.vision
                ? [{ type: "image" as const, image: new URL(image) }]
                : []),
            ],
          },
        ],
        providerOptions: { refuseless: { reasoningEffort: "high" } },
        tools: {
          read: tool({ inputSchema: jsonSchema({ type: "object", properties: {} }), execute: async () => "canary" }),
        },
        stopWhen: stepCountIs(2),
      })
      expect(await result.text).toBe("canary")
      expect(await result.reasoningText).toContain("Checking the fixture.")
      expect(calls).toHaveLength(2)
      expect((await result.totalUsage).inputTokens).toBe(20)
    },
  )
})
