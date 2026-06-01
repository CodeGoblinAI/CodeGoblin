import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "fs/promises"
import os from "os"
import path from "path"
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

test("addToConfig writes the MCP entry into opencode.json", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codegoblin-market-"))
  try {
    const entry = Market.get("supabase")!
    const configPath = await Market.addToConfig(entry, root)
    expect(configPath).toBe(path.join(root, "opencode.json"))
    const config = JSON.parse(await readFile(configPath, "utf8"))
    expect(config.mcp.supabase).toEqual(entry.mcp)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("addToConfig rejects non-MCP entries", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codegoblin-market-bad-"))
  try {
    const fake = { id: "x", name: "X", kind: "skill", category: "c", description: "d" } as const
    await expect(Market.addToConfig(fake, root)).rejects.toThrow("is not an MCP server")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
