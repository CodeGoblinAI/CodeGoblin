import { describe, expect, test } from "bun:test"
import { addSpend, atPeak, costOf, formatInput, priceOf, readUsage, type Price } from "../src/core/context"
import { builtInPrices, usableCatalog } from "../src/core/catalog"
import { PROVIDERS, applyCatalogPrices } from "../src/core/providers"

describe("reading what a provider says it used", () => {
  test("the cached part of the prompt, wherever the provider puts it", () => {
    expect(readUsage({ prompt_tokens: 1000, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 800 } })).toEqual({ input: 1000, output: 50, cached: 800 })
    expect(readUsage({ prompt_tokens: 1000, completion_tokens: 50, prompt_cache_hit_tokens: 600, prompt_cache_miss_tokens: 400 })).toEqual({ input: 1000, output: 50, cached: 600 })
    expect(readUsage({ prompt_tokens: 1000, completion_tokens: 50, cached_tokens: 300 })).toEqual({ input: 1000, output: 50, cached: 300 })
  })

  test("no cache figure, a silly one, or no usage at all", () => {
    expect(readUsage({ prompt_tokens: 10, completion_tokens: 2 })).toEqual({ input: 10, output: 2 })
    // More cached than was sent cannot be; it is held to the prompt.
    expect(readUsage({ prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 99 } })).toEqual({ input: 10, output: 2, cached: 10 })
    expect(readUsage({ prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details: { cached_tokens: "lots" } })).toEqual({ input: 10, output: 2 })
    expect(readUsage({ prompt_tokens: 0, completion_tokens: 0 })).toBeUndefined()
    expect(readUsage(undefined)).toBeUndefined()
    expect(readUsage("usage")).toBeUndefined()
  })
})

describe("a provider that reports the cost itself", () => {
  // The shape Experiential Labs returned on 2026-11-13: the second of two identical requests.
  const usage = { prompt_tokens: 3827, completion_tokens: 17, prompt_tokens_details: { cached_tokens: 3584, cache_write_tokens: 0 }, cost: 0.000229712, is_byok: false }

  test("its figure is used instead of the price table - only where the provider is known to report dollars", () => {
    expect(readUsage(usage, true)).toEqual({ input: 3827, output: 17, cached: 3584, dollars: 0.000229712 })
    expect(readUsage(usage)).toEqual({ input: 3827, output: 17, cached: 3584 })
    expect(readUsage({ ...usage, cost: "free" }, true)!.dollars).toBeUndefined()
    expect(readUsage({ ...usage, cost: -1 }, true)!.dollars).toBeUndefined()
    expect(PROVIDERS.explabs!.reportsCost).toBe(true)
    expect(PROVIDERS.deepseek!.reportsCost).toBeUndefined()
  })

  test("costOf prefers it, and falls back to the table", () => {
    expect(costOf({ input: 1_000_000, output: 0, dollars: 0.5 }, { input: 1, output: 1 })).toBe(0.5)
    expect(costOf({ input: 1_000_000, output: 0, dollars: 0 }, { input: 1, output: 1 })).toBe(0)
    expect(costOf({ input: 1_000_000, output: 0 }, { input: 1, output: 1 })).toBeCloseTo(1, 9)
    expect(costOf({ input: 1, output: 1 }, undefined)).toBeUndefined()
  })
})

describe("pricing a turn", () => {
  const price: Price = { input: 1, output: 4, cacheRead: 0.1 }

  test("cached input is charged at the cache price", () => {
    expect(priceOf({ input: 1_000_000, output: 0, cached: 900_000 }, price)).toBeCloseTo(0.1 + 0.09, 9)
    expect(priceOf({ input: 1_000_000, output: 0 }, price)).toBeCloseTo(1, 9)
  })

  test("with no published cache price, cached input counts in full: over, never under", () => {
    expect(priceOf({ input: 1_000_000, output: 0, cached: 900_000 }, { input: 1, output: 4 })).toBeCloseTo(1, 9)
  })

  test("peak hours multiply the price, on weekdays only", () => {
    const peaky: Price = { input: 1, output: 1, peak: { times: 2, hoursUtc: [[1, 4], [6, 10]] } }
    const at = (iso: string) => new Date(iso)
    // 2026-11-13 is a Friday, the 14th a Saturday.
    expect(atPeak(peaky, at("2026-11-13T02:30:00Z"))).toBe(true)
    expect(atPeak(peaky, at("2026-11-13T04:00:00Z"))).toBe(false)
    expect(atPeak(peaky, at("2026-11-13T09:59:00Z"))).toBe(true)
    expect(atPeak(peaky, at("2026-11-14T02:30:00Z"))).toBe(false)
    expect(atPeak({ input: 1, output: 1 }, at("2026-11-13T02:30:00Z"))).toBe(false)
    expect(priceOf({ input: 1_000_000, output: 0 }, peaky, at("2026-11-13T02:30:00Z"))).toBeCloseTo(2, 9)
    expect(priceOf({ input: 1_000_000, output: 0 }, peaky, at("2026-11-13T12:00:00Z"))).toBeCloseTo(1, 9)
  })

  test("a session adds its cached tokens up, and says so", () => {
    const total = addSpend(addSpend({ input: 0, output: 0 }, { input: 100, output: 5, cached: 60, dollars: 0.01 }), { input: 200, output: 5, dollars: 0.02 })
    expect(total).toMatchObject({ input: 300, output: 10, cached: 60 })
    expect(formatInput(total)).toBe("300 (60 cached)")
    expect(formatInput({ input: 1234 })).toBe((1234).toLocaleString())
    expect(addSpend({ input: 1, output: 1 }, { input: 1, output: 1 }).cached).toBeUndefined()
  })
})

describe("prices from the catalog", () => {
  const raw = {
    zai: { id: "zai", models: {
      a: { id: "glm-5.3-flash", cost: { input: 0.2, output: 0.7, cache_read: 0.04 } },
      free: { id: "glm-4.7-flash", cost: { input: 0, output: 0, cache_read: 0 } },
      odd: { id: "glm-odd", cost: { input: 1, output: 2, cache_read: 5 } },
      none: { id: "glm-none" },
    } },
    acme: { id: "acme", npm: "@ai-sdk/openai-compatible", api: "https://api.acme.test/v1", models: {
      m: { id: "acme-1", tool_call: true, cost: { input: 1, output: 4, cache_read: 0.25 } },
    } },
  }

  test("built-in providers' prices are picked out, with the cache price; free and unpriced models are not", () => {
    const prices = builtInPrices(raw)
    expect(Object.keys(prices)).toEqual(["zai"])
    expect(prices.zai!["glm-5.3-flash"]).toEqual({ input: 0.2, output: 0.7, cacheRead: 0.04 })
    expect(prices.zai!["glm-4.7-flash"]).toBeUndefined()
    // A cache price above the input price is a mistake in the data; the full price stands.
    expect(prices.zai!["glm-odd"]).toEqual({ input: 1, output: 2 })
    expect(builtInPrices(null)).toEqual({})
  })

  test("a catalog provider's models carry the cache price too", () => {
    expect(usableCatalog(raw).find((p) => p.id === "acme")!.models[0]!.price).toEqual({ input: 1, output: 4, cacheRead: 0.25 })
  })

  test("they replace the hand-written prices, keeping a peak schedule", () => {
    const flash = PROVIDERS.zai!.models.find((m) => m.id === "glm-5.3-flash")!
    const deepseek = PROVIDERS.deepseek!.models.find((m) => m.id === "deepseek-v4-flash")!
    const before = [flash.price, deepseek.price]
    try {
      expect(applyCatalogPrices({ ...builtInPrices(raw), deepseek: { "deepseek-v4-flash": { input: 0.2, output: 0.8, cacheRead: 0.004 } }, nobody: { x: { input: 1, output: 1 } } })).toBe(2)
      expect(flash.price).toEqual({ input: 0.2, output: 0.7, cacheRead: 0.04 })
      expect(deepseek.price).toMatchObject({ input: 0.2, output: 0.8, cacheRead: 0.004, peak: { times: 2 } })
    } finally {
      flash.price = before[0]
      deepseek.price = before[1]
    }
  })

  test("every built-in chat model of a paid key provider has a price, so the spend brake can see it", () => {
    for (const id of ["deepseek", "zai", "openai", "xiaomi", "meta"]) {
      for (const model of PROVIDERS[id]!.models) {
        if (model.capabilities?.output && !model.capabilities.output.text) continue
        if (model.contextWindow <= 0) continue
        expect([id, model.id, Boolean(model.price)]).toEqual([id, model.id, true])
      }
    }
  })
})

describe("several usage reports for one answer", () => {
  test("only what a report adds to the one before it is counted", async () => {
    const { usageSince } = await import("../src/core/context")
    expect(usageSince({ input: 67, output: 0 }, undefined)).toEqual({ input: 67, output: 0 })
    expect(usageSince({ input: 67, output: 5 }, { input: 67, output: 1 })).toEqual({ input: 0, output: 4 })
    expect(usageSince({ input: 67, output: 5, cached: 40 }, { input: 67, output: 5, cached: 40 })).toBeUndefined()
    // A provider that reports dollars: the bill so far, not a new bill each time.
    expect(usageSince({ input: 67, output: 9, dollars: 0.003 }, { input: 67, output: 5, dollars: 0.002 })!.dollars).toBeCloseTo(0.001, 9)
    // A total that went down is not a refund.
    expect(usageSince({ input: 10, output: 1 }, { input: 67, output: 5 })).toBeUndefined()
  })
})
