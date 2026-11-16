import { expect, test } from "bun:test"
import { REFUSELESS_BUILT_IN, fetchRefuselessModels, refuselessModels } from "../src/core/refuseless"
import { CONNECTABLE, PROVIDERS, kindOf, refreshRefuselessModels, resolveSelection } from "../src/core/providers"

const row = (id: string, extra: Record<string, unknown> = {}) => ({
  id, object: "model", vision: true, context_length: 1_048_576, reasoning_efforts: ["off", "low", "high", "max"], reasoning_default: "low",
  pricing: { currency: "USD", input_per_m: 0.01, cached_input_per_m: 0.002, output_per_m: 0.08 }, ...extra,
})

test("the eight catalog models are built in, named, priced and a million tokens wide", () => {
  expect(REFUSELESS_BUILT_IN.map((model) => model.id)).toEqual([
    "deepseek-v4.1-flash-abliterated", "deepseek-v4.1-flash-abliterated-fast", "deepseek-v4.1-flash-abliterated-free", "deepseek-v4.1-flash-fast",
    "glm-5.3-abliterated", "glm-5.3-flash-abliterated", "kimi-k3.1-pro", "minimax-m3.1-flash",
  ])
  for (const model of REFUSELESS_BUILT_IN) {
    expect(model.contextWindow).toBe(1_048_576)
    expect(model.price!.input).toBeGreaterThan(0)
    expect(model.price!.cacheRead).toBeGreaterThan(0)
    expect(model.label).not.toBe(model.id)
    expect(kindOf(model)).toBe("text")
  }
})

test("the route called free is priced like the paid one it mirrors", () => {
  const free = REFUSELESS_BUILT_IN.find((model) => model.id.endsWith("-free"))!
  expect(free.price).toEqual({ input: 0.12, output: 0.45, cacheRead: 0.019 })
})

test("effort levels are the catalog's own: never medium, and off only where it is listed", () => {
  for (const model of REFUSELESS_BUILT_IN) {
    expect(model.reasoning).toBe(true)
    expect(model.efforts).not.toContain("medium")
    expect(model.defaultEffort).toBe("low")
  }
  const by = (id: string) => REFUSELESS_BUILT_IN.find((model) => model.id === id)!
  expect(by("deepseek-v4.1-flash-fast").efforts).toEqual(["off", "low", "high", "max"])
  expect(by("deepseek-v4.1-flash-abliterated-free").efforts).toEqual(["low", "high", "max"])
  expect(by("glm-5.3-abliterated").efforts).toEqual(["low", "high", "max"])
})

test("only the model the catalog says cannot see is without vision", () => {
  const blind = REFUSELESS_BUILT_IN.filter((model) => !model.capabilities?.input?.image).map((model) => model.id)
  expect(blind).toEqual(["glm-5.3-abliterated"])
})

test("a row without an id, a context size or a USD price is left out", () => {
  const kept = refuselessModels([
    row("good"), row("no-price", { pricing: undefined }), row("euros", { pricing: { currency: "EUR", input_per_m: 1, output_per_m: 1 } }),
    row("no-context", { context_length: 0 }), row("bad id!"), null, "text", row("negative", { pricing: { currency: "USD", input_per_m: -1, output_per_m: 1 } }),
  ])
  expect(kept.map((model) => model.id)).toEqual(["good"])
})

test("a model whose only level is off does not reason, and an unknown model keeps its id as its name", () => {
  const [model] = refuselessModels([row("new-model", { reasoning_efforts: ["off"], vision: false })])
  expect(model!.reasoning).toBeUndefined()
  expect(model!.efforts).toBeUndefined()
  expect(model!.label).toBe("new-model")
  expect(model!.capabilities).toBeUndefined()
})

test("the catalog is read without a key, and a bad answer is an error rather than an empty list", async () => {
  let sent: RequestInit | undefined, url = ""
  const good = (async (input: RequestInfo | URL, init?: RequestInit) => { url = String(input); sent = init; return Response.json({ object: "list", data: [row("live-one")] }) }) as unknown as typeof fetch
  expect((await fetchRefuselessModels(good)).map((model) => model.id)).toEqual(["live-one"])
  expect(url).toBe("https://api.refuseless.com/v1/models")
  expect(JSON.stringify(sent?.headers ?? {})).not.toContain("uthorization")
  await expect(fetchRefuselessModels((async () => new Response("no", { status: 403 })) as unknown as typeof fetch)).rejects.toThrow("403")
  await expect(fetchRefuselessModels((async () => Response.json({ object: "list", data: [] })) as unknown as typeof fetch)).rejects.toThrow()
  await expect(fetchRefuselessModels((async () => Response.json({ models: [] })) as unknown as typeof fetch)).rejects.toThrow()
})

test("the provider is in the catalogue and in /connect, and a refused refresh keeps the built-in list", async () => {
  const provider = PROVIDERS.refuseless!
  expect(provider.baseUrl).toBe("https://api.refuseless.com/v1/chat/completions")
  expect(provider.usageOnStream).toBe(true)
  expect(CONNECTABLE.some((entry) => entry.id === "refuseless" && !entry.more)).toBe(true)
  expect(await refreshRefuselessModels((async () => new Response("no", { status: 403 })) as unknown as typeof fetch)).toBe(provider.models.length)
  expect(provider.models.length).toBeGreaterThanOrEqual(8)
  expect(resolveSelection("refuseless/deepseek-v4.1-flash-fast")?.model.id).toBe("deepseek-v4.1-flash-fast")
})

test("the price list is asked for with the key when there is one, and without when there is not", async () => {
  const seen: (string | null)[] = []
  const list = (async (_url: string | URL | Request, init?: RequestInit) => {
    seen.push(new Headers(init?.headers).get("authorization"))
    expect(init?.redirect).toBe("error")
    return Response.json({ object: "list", data: [{ id: "live-one", context_length: 1000, pricing: { currency: "USD", input_per_m: 1, output_per_m: 2 } }] })
  }) as unknown as typeof fetch
  await fetchRefuselessModels(list, "the-key")
  await fetchRefuselessModels(list)
  expect(seen).toEqual(["Bearer the-key", null])
})
