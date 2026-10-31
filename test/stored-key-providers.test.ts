import { expect, test } from "bun:test"
import { experientialModels, fetchExperientialModels } from "../src/core/experiential"
import { PROVIDERS, discoverModels, isChatModel, kindOf, refreshExperientialModels, resolveSelection } from "../src/core/providers"
import { apiKey } from "../src/core/auth"
import { runAgent } from "../src/core/agent"

const row = (slug: string, over: Record<string, unknown> = {}, route: Record<string, unknown> = {}) => ({
  model: { slug, display_name: slug.toUpperCase(), status: "active", context_window: 200000, max_output_tokens: 8000, input_modalities: ["text"], output_modalities: ["text"], supported_params: { tools: true }, ...over },
  default_provider_ids: ["r1"],
  providers: [{ id: "r1", status: "active", routable: true, input_nano_usd_per_million: 300_000_000, output_nano_usd_per_million: 1_200_000_000, capabilities: { supports_streaming: true }, ...route }],
})

test("Experiential keeps only active, priced, routable, tool-capable text models, in USD", () => {
  const models = experientialModels([
    row("good-model", { input_modalities: ["text", "image"], supported_params: { tools: true, reasoning: true } }),
    row("retired", { status: "deprecated" }),
    row("no-tools", { supported_params: { tools: false } }),
    row("unpriced", {}, { input_nano_usd_per_million: null }),
    row("unroutable", {}, { routable: false }),
    row("no-stream", {}, { capabilities: { supports_streaming: false } }),
    row("image-out", { output_modalities: ["image"] }),
    { junk: true },
  ])
  expect(models.map((model) => model.id)).toEqual(["good-model"])
  expect(models[0]).toMatchObject({ label: "GOOD-MODEL", contextWindow: 200000, price: { input: 0.3, output: 1.2 }, reasoning: true, capabilities: { input: { image: true } } })
})

test("the catalog is read page by page with no key, and a bad page is refused", async () => {
  const urls: string[] = []
  const pages = [{ models: [row("a")], total: 2, limit: 1, offset: 0 }, { models: [row("b")], total: 2, limit: 1, offset: 1 }]
  const fetcher = (async (url: string, init: RequestInit) => {
    urls.push(String(url))
    expect(JSON.stringify(init.headers ?? {})).not.toMatch(/authorization/i)
    return Response.json(pages[urls.length - 1])
  }) as typeof fetch
  expect((await fetchExperientialModels(fetcher)).map((model) => model.id)).toEqual(["a", "b"])
  expect(urls[1]).toContain("offset=1")
  await expect(fetchExperientialModels((async () => Response.json({ models: [], total: 0, limit: 0, offset: 5 })) as typeof fetch)).rejects.toThrow()
  // The surfaces' refresh fills the provider once; a failure would have kept the cache.
  expect(await refreshExperientialModels((async () => Response.json({ models: [row("live-one")], total: 1, limit: 100, offset: 0 })) as typeof fetch)).toBe(1)
  expect(resolveSelection("explabs/live-one")?.provider.id).toBe("explabs")
})

test("each stored-key provider chats with its own key; OpenAI keeps its image model too", () => {
  for (const [id, endpoint] of [["openai", "api.openai.com"], ["xiaomi", "api.xiaomimimo.com"], ["meta", "api.meta.ai"], ["explabs", "api.experientiallabs.ai"]] as const) {
    expect(PROVIDERS[id]!.baseUrl).toContain(endpoint)
    expect(apiKey(id)).not.toBe("")
  }
  for (const model of [...PROVIDERS.openai!.models, ...PROVIDERS.xiaomi!.models, ...PROVIDERS.meta!.models].filter((entry) => kindOf(entry) === "text")) {
    expect(model.price).toBeDefined()
    expect(model.contextWindow).toBeGreaterThan(100_000)
  }
  expect(isChatModel(resolveSelection("openai/gpt-5.6")!)).toBe(true)
  expect(kindOf(resolveSelection("openai/gpt-image-1")!.model)).toBe("image")
  expect(isChatModel(resolveSelection("xiaomi/mimo-v2.5")!)).toBe(true)
  expect(isChatModel(resolveSelection("meta/muse-spark-1.3")!)).toBe(true)
})

test("live discovery lists what the key may call: catalog facts kept, new models unpriced, non-chat dropped", async () => {
  const provider = { id: "fake", label: "Fake", baseUrl: "https://api.example.invalid/v1/chat/completions", liveModels: { context: 262_144 },
    models: [{ id: "old-catalog", label: "Old", contextWindow: 1_000_000, price: { input: 1, output: 2 } }, { id: "kept", label: "Kept", contextWindow: 500_000, price: { input: 0.1, output: 0.2 } }] }
  let asked = ""
  const ok = await discoverModels(provider, "key", (async (url: string, init: RequestInit) => {
    asked = String(url) + " " + JSON.stringify(init.headers)
    return Response.json({ data: [{ id: "kept" }, { id: "brand-new-v2.6" }, { id: "brand-tts" }, { id: "brand-asr" }, { id: "image-1.0" }] })
  }) as typeof fetch)
  expect(ok).toBe(true)
  expect(asked).toContain("https://api.example.invalid/v1/models")
  expect(asked).toContain("Bearer key")
  expect(provider.models).toEqual([
    { id: "kept", label: "Kept", contextWindow: 500_000, price: { input: 0.1, output: 0.2 } },
    { id: "brand-new-v2.6", label: "brand-new-v2.6", contextWindow: 262_144 },
  ])
  // A refusal keeps what was there.
  expect(await discoverModels(provider, "key", (async () => new Response("no", { status: 401 })) as typeof fetch)).toBe(false)
  expect(provider.models).toHaveLength(2)
})

test("OpenAI-style providers are asked for usage on the stream, so spend is known", async () => {
  let body: Record<string, unknown> = {}
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    body = JSON.parse(String(init.body))
    return new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":1}}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } })
  }) as typeof fetch
  try {
    const events = []
    for await (const event of runAgent({ provider: PROVIDERS.openai!, modelId: "gpt-5.4-nano", apiKey: "k", root: process.cwd(), messages: [{ role: "user", content: "hi" }] })) events.push(event)
    expect(body.stream_options).toEqual({ include_usage: true })
    expect(events).toContainEqual({ type: "spend", input: 3, output: 1 })
  } finally { globalThis.fetch = realFetch }
})
