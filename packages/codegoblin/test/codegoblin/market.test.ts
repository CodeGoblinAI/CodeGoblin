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

test("addToConfig writes the MCP entry into codegoblin.jsonc by default", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codegoblin-market-"))
  try {
    const entry = Market.get("supabase")!
    const configPath = await Market.addToConfig(entry, root, { SUPABASE_ACCESS_TOKEN: "sbp_test_token" })
    expect(configPath).toBe(path.join(root, "codegoblin.jsonc"))
    const config = JSON.parse(await readFile(configPath, "utf8"))
    expect(config.mcp.supabase.environment.SUPABASE_ACCESS_TOKEN).toBe("sbp_test_token")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("addToConfig writes into an existing codegoblin.jsonc", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codegoblin-market-existing-"))
  try {
    const configPath = path.join(root, "codegoblin.jsonc")
    await Bun.write(configPath, '{"agent":{}}')
    const entry = Market.get("firebase")!
    const resolved = await Market.addToConfig(entry, root)
    expect(resolved).toBe(configPath)
    const config = JSON.parse(await readFile(configPath, "utf8"))
    expect(config.mcp.firebase).toEqual(entry.mcp)
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

test("validateEnv requires catalog env fields", () => {
  const notion = Market.get("notion")!
  expect(Market.validateEnv(notion, undefined)).toContain("Notion API Token")
  expect(Market.validateEnv(notion, { NOTION_TOKEN: "secret_abc" })).toBeUndefined()
  const playwright = Market.get("playwright")!
  expect(Market.validateEnv(playwright, undefined)).toBeUndefined()
})

test("materializeMcp substitutes env placeholders with a single secret copy (no baked headers)", () => {
  const notion = Market.get("notion")!
  const mcp = Market.materializeMcp(notion, { NOTION_TOKEN: "secret_notion" })
  expect(mcp.type).toBe("local")
  if (mcp.type !== "local") return
  expect(mcp.environment?.NOTION_TOKEN).toBe("secret_notion")
  // OPENAPI_MCP_HEADERS must NOT be persisted (it duplicates the token on disk); it is re-derived
  // at spawn time by augmentNotionEnvironment.
  expect(mcp.environment?.OPENAPI_MCP_HEADERS).toBeUndefined()
})

test("augmentNotionEnvironment adds OPENAPI_MCP_HEADERS at spawn time from NOTION_TOKEN", () => {
  const next = Market.augmentNotionEnvironment({ NOTION_TOKEN: "secret_notion" })
  expect(next.OPENAPI_MCP_HEADERS).toContain("Bearer secret_notion")
  expect(next.OPENAPI_MCP_HEADERS).toContain("2022-06-28")
})

test("addToConfig rejects env-required entries without secrets", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codegoblin-market-env-"))
  try {
    const entry = Market.get("notion")!
    await expect(Market.addToConfig(entry, root)).rejects.toThrow("Notion API Token is required")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("mcpNeedsEnv detects missing or placeholder secrets", () => {
  const notion = Market.get("notion")!
  expect(Market.mcpNeedsEnv(notion)).toBe(true)
  expect(
    Market.mcpNeedsEnv(notion, {
      type: "local",
      command: ["npx"],
      environment: { NOTION_TOKEN: "${NOTION_TOKEN}" },
      enabled: true,
    }),
  ).toBe(true)
  expect(
    Market.mcpNeedsEnv(notion, {
      type: "local",
      command: ["npx"],
      environment: { NOTION_TOKEN: "secret_abc" },
      enabled: true,
    }),
  ).toBe(false)
  const playwright = Market.get("playwright")!
  expect(Market.mcpNeedsEnv(playwright)).toBe(false)
})

test("findMcpConfigPath locates entries in opencode.json", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codegoblin-market-find-"))
  try {
    const configPath = path.join(root, "opencode.json")
    await Bun.write(
      configPath,
      JSON.stringify({
        mcp: {
          notion: {
            type: "local",
            command: ["npx", "-y", "@notionhq/notion-mcp-server"],
            environment: { NOTION_TOKEN: "secret_test" },
            enabled: true,
          },
        },
      }),
    )
    expect(await Market.findMcpConfigPath("notion", root)).toBe(configPath)
    const merged = await Market.readMergedMcpFromDir(root)
    const notion = merged.notion
    expect(notion?.type).toBe("local")
    if (notion?.type !== "local") return
    expect(notion.environment?.NOTION_TOKEN).toBe("secret_test")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("removeFromAllScopes succeeds when MCP is runtime-only", async () => {
  const result = await Market.removeFromAllScopes("notion")
  expect(result.removedFromConfig).toBe(false)
  expect(result.configPath).toBeUndefined()
})

test("removeFromConfig deletes an installed MCP entry", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codegoblin-market-remove-"))
  try {
    const entry = Market.get("firebase")!
    await Market.addToConfig(entry, root)
    const configPath = await Market.removeFromConfig("firebase", root)
    expect(configPath).toBe(path.join(root, "codegoblin.jsonc"))
    const config = JSON.parse(await readFile(configPath, "utf8"))
    expect(config.mcp?.firebase).toBeUndefined()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
