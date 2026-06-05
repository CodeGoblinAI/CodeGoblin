import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { readConnectedProviderKey } from "@/codegoblin/connected-auth"

describe("readConnectedProviderKey", () => {
  let dataDir: string

  beforeAll(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "codegoblin-auth-"))
    await fs.writeFile(
      path.join(dataDir, "auth.json"),
      JSON.stringify({
        tripo: { type: "api", key: "tripo-secret" },
        google: { type: "oauth", refresh: "r", access: "a", expires: 0 },
        broken: { type: "api" },
      }),
      "utf8",
    )
  })

  afterAll(async () => {
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {})
  })

  test("returns the api key from the overridden data dir", async () => {
    expect(await readConnectedProviderKey("tripo", dataDir)).toBe("tripo-secret")
  })

  test("returns undefined for unknown providers", async () => {
    expect(await readConnectedProviderKey("openai", dataDir)).toBeUndefined()
  })

  test("ignores non-api auth entries (e.g. oauth)", async () => {
    expect(await readConnectedProviderKey("google", dataDir)).toBeUndefined()
  })

  test("ignores api entries without a string key", async () => {
    expect(await readConnectedProviderKey("broken", dataDir)).toBeUndefined()
  })

  test("returns undefined when auth.json is missing", async () => {
    const empty = await fs.mkdtemp(path.join(os.tmpdir(), "codegoblin-auth-empty-"))
    try {
      expect(await readConnectedProviderKey("tripo", empty)).toBeUndefined()
    } finally {
      await fs.rm(empty, { recursive: true, force: true }).catch(() => {})
    }
  })

  test("returns undefined when auth.json is malformed", async () => {
    const bad = await fs.mkdtemp(path.join(os.tmpdir(), "codegoblin-auth-bad-"))
    try {
      await fs.writeFile(path.join(bad, "auth.json"), "{ not json", "utf8")
      expect(await readConnectedProviderKey("tripo", bad)).toBeUndefined()
    } finally {
      await fs.rm(bad, { recursive: true, force: true }).catch(() => {})
    }
  })
})
