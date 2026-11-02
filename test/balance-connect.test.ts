import { describe, expect, test } from "bun:test"
import { fetchBalance } from "../src/core/balance"
import { CONNECTABLE, FEATURED_CATALOG, connectChoices } from "../src/core/providers"

const reply = (routes: Record<string, unknown>) => (async (url: string) => {
  const body = routes[url]
  return body === undefined ? new Response("{}", { status: 404 }) : new Response(JSON.stringify(body), { status: 200 })
}) as unknown as (url: string, init: RequestInit) => Promise<Response>

describe("Experiential Labs balance", () => {
  test("credits left, total and used, plus this key's spend and daily limit", async () => {
    const snapshot = await fetchBalance("explabs", "xpl_fake", reply({
      "https://api.experientiallabs.ai/api/v1/credits": { data: { total_credits: 25, total_usage: 7.3456 } },
      "https://api.experientiallabs.ai/api/v1/key": { data: { usage_daily: 0.42, usage_monthly: 7.1, limit: null, limit_remaining: null } },
    }))
    expect(snapshot.state).toBe("ready")
    expect(snapshot.entries).toEqual([
      { label: "Credits left", amount: "17.65", unit: "USD" },
      { label: "Total credits", amount: "25.00", unit: "USD" },
      { label: "Used", amount: "7.35", unit: "USD" },
      { label: "This key today", amount: "0.42", unit: "USD" },
      { label: "This key this month", amount: "7.10", unit: "USD" },
      { label: "Daily limit", amount: "none", unit: "set on this key" },
    ])
  })

  test("the balance stands even if the per-key figures cannot be had; a daily cap is shown when set", async () => {
    const without = await fetchBalance("explabs", "xpl_fake", reply({ "https://api.experientiallabs.ai/api/v1/credits": { data: { total_credits: 5, total_usage: 5 } } }))
    expect(without.state).toBe("ready")
    expect(without.detail).toContain("no credits left")
    expect(without.entries.map((e) => e.label)).toEqual(["Credits left", "Total credits", "Used"])
    const capped = await fetchBalance("explabs", "xpl_fake", reply({
      "https://api.experientiallabs.ai/api/v1/credits": { data: { total_credits: 10, total_usage: 1 } },
      "https://api.experientiallabs.ai/api/v1/key": { data: { limit: 2, limit_remaining: 1.5 } },
    }))
    expect(capped.entries.at(-1)).toEqual({ label: "Daily limit left", amount: "1.50", unit: "of 2.00 USD" })
  })

  test("providers with no balance API say so, and where to look", async () => {
    expect((await fetchBalance("zai", "k")).detail).toContain("Z.ai has no balance API")
    expect((await fetchBalance("xiaomi", "k")).detail).toContain("platform.xiaomimimo.com")
    expect((await fetchBalance("meta", "k")).state).toBe("unsupported")
  })
})

describe("/connect's list", () => {
  test("short until something is typed: built-ins, featured and connected providers, then how many more", () => {
    const added = [
      { id: "openrouter", label: "OpenRouter", about: "280 models, from models.dev" },
      { id: "nvidia", label: "Nvidia", about: "40 models, from models.dev", more: true },
      { id: "obscure-ai", label: "Obscure AI", about: "2 models, from models.dev", more: true },
    ]
    CONNECTABLE.push(...added)
    try {
      expect(FEATURED_CATALOG).toContain("openrouter")
      const short = connectChoices("", (id) => id === "obscure-ai")
      const ids = short.map((row) => row.id)
      expect(ids).toContain("deepseek")
      expect(ids).toContain("openrouter")
      expect(ids).toContain("obscure-ai")
      expect(ids).not.toContain("nvidia")
      expect(short.at(-1)).toMatchObject({ id: "", label: "… 1 more provider" })
      expect(connectChoices("nvid", () => false).map((row) => row.id)).toEqual(["nvidia"])
    } finally {
      CONNECTABLE.splice(CONNECTABLE.length - added.length, added.length)
    }
  })
})
