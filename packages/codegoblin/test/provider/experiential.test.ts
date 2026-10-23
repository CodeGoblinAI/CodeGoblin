import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import * as ModelsDev from "@codegoblin/core/models-dev"
import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import { jsonSchema, stepCountIs, streamText, tool } from "ai"
import { experientialCatalog, experientialModels } from "../../src/provider/experiential"
import deepseek from "./fixtures/experiential-deepseek-uncensored.json"

function row() {
  return {
    model: {
      slug: "claude-opus-5.5",
      display_name: "Claude Opus 5.5",
      status: "active",
      release_date: "2026-09-22",
      context_window: 1000000,
      max_input_tokens: 900000,
      max_output_tokens: 128000,
      input_modalities: ["text", "image", "pdf"],
      output_modalities: ["text"],
      supported_params: { tools: true, reasoning: true, temperature: true },
    },
    default_provider_ids: ["default"],
    providers: [
      { id: "other", input_nano_usd_per_million: 99000000000, output_nano_usd_per_million: 99000000000 },
      {
        id: "default",
        input_nano_usd_per_million: 4000000000,
        output_nano_usd_per_million: 20000000000,
        cached_input_nano_usd_per_million: 200000000,
        cache_write_input_nano_usd_per_million: 5000000000,
      },
    ],
  }
}

describe("Experiential Labs catalog", () => {
  test.each([{}, undefined, null])("imports DeepSeek Uncensored from route capabilities: %j", (params) => {
    // Relevant public catalog fields captured 2026-10-23. The model-level
    // capability object is empty even though its default route supports tools.
    const model = experientialModels([{ ...deepseek, model: { ...deepseek.model, supported_params: params } }])[
      "deepseek-v4.1-flash-uncensored"
    ]
    expect(model).toMatchObject({
      id: "deepseek-v4.1-flash-uncensored",
      name: "DeepSeek V4.1 Flash 1017 Uncensored",
      tool_call: true,
      reasoning: true,
      temperature: true,
      cost: { input: 0.3, output: 1.2, cache_read: 0.03, cache_write: 0.3 },
      limit: { context: 1048576, input: 655360, output: 393216 },
      modalities: { input: ["text"], output: ["text"] },
    })
    Schema.decodeUnknownSync(ModelsDev.Model)(model)
  })

  test.each(["no-tools", "no-stream", "disabled", "unroutable"])(
    "does not override an unavailable default route: %s",
    (kind) => {
      const entry = {
        ...deepseek,
        providers: deepseek.providers.map((provider) => ({
          ...provider,
          status: kind === "disabled" ? "disabled" : provider.status,
          routable: kind !== "unroutable",
          capabilities: {
            ...provider.capabilities,
            supports_tools: kind !== "no-tools",
            supports_streaming: kind !== "no-stream",
          },
        })),
      }
      expect(experientialModels([entry])).toEqual({})
    },
  )

  test("uses only the default route's capabilities and honors explicit model flags", () => {
    const entry = {
      ...deepseek,
      model: { ...deepseek.model, supported_params: { reasoning: false, temperature: false } },
      providers: [
        { ...deepseek.providers[0], id: "other", capabilities: { supports_tools: false } },
        {
          ...deepseek.providers[0],
          capabilities: deepseek.providers[0].capabilities,
        },
      ],
    }
    expect(experientialModels([entry])[deepseek.model.slug]).toMatchObject({
      tool_call: true,
      reasoning: false,
      temperature: false,
    })
    expect(experientialModels([{ ...deepseek, providers: [{ ...deepseek.providers[0], capabilities: {} }] }])).toEqual(
      {},
    )
    expect(
      experientialModels([{ ...deepseek, model: { ...deepseek.model, supported_params: { tools: false } } }]),
    ).toEqual({})
  })

  test("uses the gateway slug, default waterfall price, limits, and input modalities", () => {
    const model = experientialModels([row()])["claude-opus-5.5"]
    expect(model).toMatchObject({
      id: "claude-opus-5.5",
      name: "Claude Opus 5.5",
      tool_call: true,
      reasoning: true,
      cost: { input: 4, output: 20, cache_read: 0.2, cache_write: 5 },
      limit: { context: 1000000, input: 900000, output: 128000 },
      modalities: { input: ["text", "image", "pdf"], output: ["text"] },
    })
    Schema.decodeUnknownSync(ModelsDev.Model)(model)
  })

  test.each(["inactive", "no-tools", "embedding", "image-output", "missing-limits", "no-route", "no-stream"])(
    "excludes non-agent models: %s",
    (kind) => {
      const entry = row()
      if (kind === "inactive") entry.model.status = "disabled"
      if (kind === "no-tools") entry.model.supported_params.tools = false
      if (kind === "embedding") entry.model.output_modalities = ["embedding"]
      if (kind === "image-output") entry.model.output_modalities = ["image"]
      if (kind === "missing-limits") entry.model.context_window = 0
      if (kind === "no-route") entry.default_provider_ids = ["missing"]
      const raw =
        kind === "no-stream"
          ? {
              ...entry,
              providers: entry.providers.map((item) => ({ ...item, capabilities: { supports_streaming: false } })),
            }
          : entry
      expect(experientialModels([raw])).toEqual({})
    },
  )

  test("ignores malformed rows without discarding good models", () => {
    expect(Object.keys(experientialModels([null, {}, { model: { slug: 42 } }, row()]))).toEqual(["claude-opus-5.5"])
  })

  test("keeps promotion labels out of model names and does not guess missing prices", () => {
    const entry = { ...row(), promotional_listed: true }
    entry.providers = []
    expect(experientialModels([entry])).toEqual({})
    const unknownPrice = {
      ...row(),
      providers: [{ id: "default", input_nano_usd_per_million: null, output_nano_usd_per_million: null }],
    }
    expect(experientialModels([unknownPrice])).toEqual({})
    const negativePrice = {
      ...row(),
      providers: [{ id: "default", input_nano_usd_per_million: -1, output_nano_usd_per_million: 0 }],
    }
    expect(experientialModels([negativePrice])).toEqual({})
    expect(experientialModels([{ ...row(), promotion: { free: true } }])["claude-opus-5.5"].cost?.input).toBe(4)
  })

  test("paginates public catalog without sending credentials", async () => {
    const seen: string[] = []
    using server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(request) {
        const url = new URL(request.url)
        seen.push(url.searchParams.get("offset")!)
        expect(request.headers.get("authorization")).toBeNull()
        expect(url.searchParams.has("supports")).toBe(false)
        const entry = row()
        if (seen.length === 2) entry.model.slug = "second-model"
        return Response.json({
          models: seen.length === 1 ? [deepseek] : [entry],
          total: 2,
          limit: 1,
          offset: Number(url.searchParams.get("offset")),
        })
      },
    })
    const catalog = await experientialCatalog((url, init) =>
      fetch(`${server.url.origin}${new URL(String(url)).pathname}${new URL(String(url)).search}`, init),
    )
    expect(seen).toEqual(["0", "1"])
    expect(catalog).toMatchObject({
      id: "explabs",
      name: "Experiential Labs",
      env: ["EXPLABS_API_KEY"],
      api: "https://api.experientiallabs.ai/v1",
      npm: "@ai-sdk/openai-compatible",
    })
    expect(Object.keys(catalog.models)).toEqual(["deepseek-v4.1-flash-uncensored", "second-model"])
    Schema.decodeUnknownSync(ModelsDev.Provider)(catalog)
  })

  test("rejects failed or malformed catalog responses", async () => {
    await expect(experientialCatalog(async () => new Response("unavailable", { status: 503 }))).rejects.toThrow(
      "HTTP 503",
    )
    await expect(
      experientialCatalog(async () => Response.json({ models: [], total: 100, limit: 0, offset: 0 })),
    ).rejects.toThrow("pagination")
    await expect(
      experientialCatalog(async () => Response.json({ models: [null], total: 1, limit: 100, offset: 0 })),
    ).rejects.toThrow("no chat models")
  })

  test("catalog snapshot is valid and registers API-key models without changing existing providers", async () => {
    const snapshot = await Bun.file(new URL("../../models/api.json", import.meta.url)).json()
    const provider = Schema.decodeUnknownSync(ModelsDev.Provider)(snapshot.explabs)
    expect(Object.keys(provider.models).length).toBeGreaterThan(50)
    expect(snapshot.openai).toBeDefined()
    expect(snapshot.anthropic).toBeDefined()
    expect(provider.models["claude-opus-5.5"]).toBeDefined()
    expect(provider.models["deepseek-v4.1-flash-uncensored"]).toMatchObject({
      name: "DeepSeek V4.1 Flash 1017 Uncensored",
      tool_call: true,
      reasoning: true,
    })
    expect(provider.models["jev-latest"]).toBeUndefined()
  })

  test.each(["claude-opus-5.5", "deepseek-v4.1-flash-uncensored"])(
    "actual SDK authenticates, streams, executes a tool, and continues with the result: %s",
    async (slug) => {
      const calls: unknown[] = []
      using server = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        async fetch(request) {
          expect(new URL(request.url).pathname).toBe("/v1/chat/completions")
          expect(request.headers.get("authorization")).toBe("Bearer local-test-key")
          const body = await request.json()
          calls.push(body)
          expect(body.model).toBe(slug)
          const first = calls.length === 1
          if (!first) expect(body.messages).toContainEqual(expect.objectContaining({ role: "tool", content: "canary" }))
          const delta = first
            ? {
                tool_calls: [
                  {
                    index: 0,
                    id: "call_read",
                    type: "function",
                    function: { name: "read", arguments: '{"path":"README.md"}' },
                  },
                ],
              }
            : { content: "EXPLABS_OK" }
          return new Response(
            `data: ${JSON.stringify({ id: "test", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: "test", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: first ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`,
            { headers: { "content-type": "text/event-stream" } },
          )
        },
      })
      const result = streamText({
        model: createOpenAICompatible({
          name: "explabs",
          apiKey: "local-test-key",
          baseURL: `${server.url.origin}/v1`,
        }).chatModel(slug),
        prompt: "Read README.md",
        stopWhen: stepCountIs(2),
        tools: {
          read: tool({
            inputSchema: jsonSchema<{ path: string }>({
              type: "object",
              properties: { path: { type: "string" } },
              required: ["path"],
            }),
            execute: async ({ path }) => {
              expect(path).toBe("README.md")
              return "canary"
            },
          }),
        },
      })
      expect(await result.text).toBe("EXPLABS_OK")
      expect(calls).toHaveLength(2)
    },
  )
})
