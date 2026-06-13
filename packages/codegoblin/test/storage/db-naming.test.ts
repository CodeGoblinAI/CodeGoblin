import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { adoptLegacyDb } from "@/storage/db"

async function tmp() {
  return fs.mkdtemp(path.join(os.tmpdir(), "cg-db-naming-"))
}

describe("adoptLegacyDb", () => {
  test("renames a legacy db with its sidecars", async () => {
    const dir = await tmp()
    const legacy = path.join(dir, "opencode-dev.db")
    const next = path.join(dir, "codegoblin-dev.db")
    await fs.writeFile(legacy, "db")
    await fs.writeFile(legacy + "-wal", "wal")
    await fs.writeFile(legacy + "-shm", "shm")
    try {
      expect(adoptLegacyDb(next, legacy)).toBe(next)
      expect(await fs.readFile(next, "utf8")).toBe("db")
      expect(await fs.readFile(next + "-wal", "utf8")).toBe("wal")
      expect(await fs.readFile(next + "-shm", "utf8")).toBe("shm")
      expect(await fs.stat(legacy).catch(() => undefined)).toBeUndefined()
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  test("keeps an existing branded db untouched", async () => {
    const dir = await tmp()
    const legacy = path.join(dir, "opencode.db")
    const next = path.join(dir, "codegoblin.db")
    await fs.writeFile(legacy, "old")
    await fs.writeFile(next, "new")
    try {
      expect(adoptLegacyDb(next, legacy)).toBe(next)
      expect(await fs.readFile(next, "utf8")).toBe("new")
      expect(await fs.readFile(legacy, "utf8")).toBe("old")
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  test("fresh install: no legacy db -> branded path", async () => {
    const dir = await tmp()
    try {
      expect(adoptLegacyDb(path.join(dir, "codegoblin.db"), path.join(dir, "opencode.db"))).toBe(
        path.join(dir, "codegoblin.db"),
      )
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})
