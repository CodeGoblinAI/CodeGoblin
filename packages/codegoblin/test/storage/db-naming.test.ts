import { describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { adoptLegacyDb, legacyDbWritable } from "@/storage/db"

function makeSessionMessageDb(file: string, withSeq: boolean) {
  const db = new Database(file)
  db.run(
    `CREATE TABLE session_message (id text PRIMARY KEY, session_id text NOT NULL, type text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL${withSeq ? ", seq integer NOT NULL" : ""})`,
  )
  db.close()
}

async function tmp() {
  return fs.mkdtemp(path.join(os.tmpdir(), "cg-db-naming-"))
}

describe("adoptLegacyDb", () => {
  test("renames a legacy db with its sidecars", async () => {
    const dir = await tmp()
    const legacy = path.join(dir, "opencode-dev.db")
    const next = path.join(dir, "codegoblin-dev.db")
    // Real (compatible) sqlite DB with a row, in WAL mode so -wal/-shm sidecars exist.
    const seed = new Database(legacy)
    seed.run("PRAGMA journal_mode=WAL")
    seed.run(
      "CREATE TABLE session_message (id text PRIMARY KEY, session_id text NOT NULL, type text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL)",
    )
    seed.run("INSERT INTO session_message VALUES ('m1','s1','user',1,1,'{}')")
    seed.close()
    try {
      expect(adoptLegacyDb(next, legacy)).toBe(next)
      expect(await fs.stat(legacy).catch(() => undefined)).toBeUndefined() // legacy moved away
      // adopted DB is intact and readable (sidecars came along)
      const adopted = new Database(next, { readonly: true })
      expect(adopted.query("SELECT COUNT(*) c FROM session_message").get()).toEqual({ c: 1 })
      adopted.close()
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

  test("does NOT adopt a schema-incompatible legacy db (newer opencode), leaves it untouched", async () => {
    const dir = await tmp()
    const legacy = path.join(dir, "opencode-dev.db")
    const next = path.join(dir, "codegoblin-dev.db")
    makeSessionMessageDb(legacy, true) // has the orphaned NOT NULL `seq` -> incompatible
    try {
      expect(adoptLegacyDb(next, legacy)).toBe(next) // returns next so a fresh DB is created
      expect(await fs.stat(legacy).catch(() => undefined)).toBeDefined() // legacy left in place
      expect(await fs.stat(next).catch(() => undefined)).toBeUndefined() // nothing renamed onto next
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  test("DOES adopt a schema-compatible legacy db", async () => {
    const dir = await tmp()
    const legacy = path.join(dir, "opencode-dev.db")
    const next = path.join(dir, "codegoblin-dev.db")
    makeSessionMessageDb(legacy, false) // matches our schema -> compatible
    try {
      expect(adoptLegacyDb(next, legacy)).toBe(next)
      expect(await fs.stat(next).catch(() => undefined)).toBeDefined() // adopted
      expect(await fs.stat(legacy).catch(() => undefined)).toBeUndefined()
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  test("legacyDbWritable: seq column -> false, clean -> true, missing file -> true", async () => {
    const dir = await tmp()
    try {
      const broken = path.join(dir, "broken.db")
      const clean = path.join(dir, "clean.db")
      makeSessionMessageDb(broken, true)
      makeSessionMessageDb(clean, false)
      expect(legacyDbWritable(broken)).toBe(false)
      expect(legacyDbWritable(clean)).toBe(true)
      expect(legacyDbWritable(path.join(dir, "nope.db"))).toBe(true)
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
