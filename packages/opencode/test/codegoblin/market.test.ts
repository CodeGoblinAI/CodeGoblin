import { expect, test } from "bun:test"
import { Market, MarketCatalog } from "../../src/codegoblin/market"

test("catalog has unique ids and required fields", () => {
  const ids = MarketCatalog.map((entry) => entry.id)
  expect(new Set(ids).size).toBe(ids.length)
  for (const entry of MarketCatalog) {
    expect(entry.name.length).toBeGreaterThan(0)
    expect(entry.description.length).toBeGreaterThan(0)
    if (entry.kind === "mcp") expect(entry.mcp).toBeDefined()
  }
})

test("get is case-insensitive and list filters by kind", () => {
  expect(Market.get("SUPABASE")?.id).toBe("supabase")
  expect(Market.get("missing")).toBeUndefined()
  const mcps = Market.list({ kind: "mcp" })
  expect(mcps.length).toBeGreaterThan(0)
  expect(mcps.every((entry) => entry.kind === "mcp")).toBe(true)
})

test("categories are sorted and unique", () => {
  const categories = Market.categories()
  expect(new Set(categories).size).toBe(categories.length)
  expect([...categories].sort()).toEqual(categories)
})
