import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { chunkSegments, cursorUserText, importAntigravity, importCursor, listAntigravity, listCursor, rootMessageIds } from "../src/core/ide-import"
import { IMPORTERS, importSource } from "../src/core/conversation-import"
import { load } from "../src/core/sessions"

const base = fs.mkdtempSync(path.join(os.tmpdir(), "cg-ide-import-"))
const project = path.join(base, "proj")
const other = path.join(base, "other")
const AG_ID = "0790291a-0813-57a1-873f-51026b8c9f79"
const CUR_ID = "126d19ac-cd7a-479b-bf37-ec7dde7718fc"

/** An Antigravity index with two turns in two chunks, the way it stores them. */
function antigravityFixture() {
  const dir = path.join(base, "antigravity")
  fs.mkdirSync(dir, { recursive: true })
  const db = new Database(path.join(dir, "conversation_summaries.db"))
  db.run("create table conversation_summaries (conversation_id text, title text, preview text, workspace_uris text, last_modified_time text, parent_conversation_id text)")
  db.run("create table conversations_fts_content (id integer primary key, c0, c1, c2, c3, c4, c5, c6, c7, c8, c9, c10, c11, c12, c13, c14)")
  const uri = "file:///" + project.split(path.sep).join("/")
  db.run("insert into conversation_summaries values (?, ?, ?, ?, ?, '')", [AG_ID, "Fix the build", "", JSON.stringify([uri]), "2026-10-07 15:49:28.9+00:00"])
  db.run("insert into conversation_summaries values (?, ?, ?, ?, ?, '')", [crypto.randomUUID(), "elsewhere", "", JSON.stringify(["file:///" + other]), "2026-10-07 15:49:28.9+00:00"])
  const pieces = (list: [number, string][]) => {
    let offset = 0
    const marks: [number, number][] = []
    for (const [step, text] of list) { marks.push([step, offset]); offset += Buffer.byteLength(text) }
    return { body: list.map(([, text]) => text).join(""), offsets: JSON.stringify(marks) }
  }
  const u1 = pieces([[0, "why does the build fail? "]]), a1 = pieces([[1, "Because é is missing. "], [2, "I fixed it."]])
  const u2 = pieces([[3, "thanks - now run tests"]]), a2 = pieces([[4, "All 12 pass."]])
  // Antigravity stores the offset lists as blobs of JSON text.
  db.run("insert into conversations_fts_content (c0, c1, c8, c9, c13, c14) values (?, 0, ?, ?, ?, ?)", [AG_ID, Buffer.from(u1.offsets), Buffer.from(a1.offsets), u1.body, a1.body])
  db.run("insert into conversations_fts_content (c0, c1, c8, c9, c13, c14) values (?, 1, ?, ?, ?, ?)", [AG_ID, Buffer.from(u2.offsets), Buffer.from(a2.offsets), u2.body, a2.body])
  // A conversation it has not indexed: not offered, since there is nothing to copy.
  db.run("insert into conversation_summaries values (?, ?, ?, ?, ?, '')", [crypto.randomUUID(), "not indexed", "", JSON.stringify([uri]), "2026-10-08 15:49:28.9+00:00"])
  db.close()
  process.env.CG_ANTIGRAVITY_DIR = dir
}

/** A Cursor agent CLI chat: JSON messages, a root record listing them, meta in hex JSON. */
function cursorFixture() {
  const dir = path.join(base, "cursor", "abc123", CUR_ID)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify({ schemaVersion: 1, cwd: project, updatedAtMs: 1793400000000 }))
  const db = new Database(path.join(dir, "store.db"))
  db.run("create table blobs (id text primary key, data blob)")
  db.run("create table meta (key text primary key, value text)")
  const messages = [
    { role: "system", content: "you are cursor" },
    { role: "user", content: "<user_info>OS: windows</user_info>" },
    { role: "user", content: [{ type: "text", text: "<timestamp>now</timestamp>\n<user_query>\nadd a dark mode\n</user_query>" }] },
    { role: "assistant", content: [{ type: "reasoning", text: "thinking" }, { type: "text", text: "Added it in theme.ts." }] },
    { role: "tool", content: [{ type: "tool-result", output: "ok" }] },
  ]
  const ids = messages.map((message) => {
    const data = Buffer.from(JSON.stringify(message))
    const id = crypto.createHash("sha256").update(data).digest("hex")
    db.run("insert into blobs values (?, ?)", [id, data])
    return id
  })
  const root = Buffer.concat([...ids.map((id) => Buffer.concat([Buffer.from([0x0a, 32]), Buffer.from(id, "hex")])), Buffer.from([0x50, 0x01])])
  const rootId = crypto.createHash("sha256").update(root).digest("hex")
  db.run("insert into blobs values (?, ?)", [rootId, root])
  db.run("insert into meta values ('0', ?)", [Buffer.from(JSON.stringify({ agentId: CUR_ID, latestRootBlobId: rootId, name: "Dark mode" })).toString("hex")])
  db.close()
  process.env.CG_CURSOR_CHATS_DIR = path.join(base, "cursor")
}

beforeAll(() => { fs.mkdirSync(project, { recursive: true }); antigravityFixture(); cursorFixture() })
afterAll(() => { delete process.env.CG_ANTIGRAVITY_DIR; delete process.env.CG_CURSOR_CHATS_DIR })

describe("Antigravity", () => {
  test("lists only this project's conversations", async () => {
    const listed = await listAntigravity(project)
    expect(listed.sessions.map((s) => s.title)).toEqual(["Fix the build"])
    // The other project's conversation has nothing in the index, so there is nothing to offer.
    expect((await listAntigravity(other)).sessions).toEqual([])
  })

  test("puts the turns back in order from the index's byte offsets, multi-byte text included", async () => {
    const imported = await importAntigravity(AG_ID, project, "zai")
    const saved = (await load(imported.id))!
    expect(saved.messages.map((m) => [m.role, m.content])).toEqual([
      ["user", "why does the build fail?"],
      ["assistant", "Because é is missing.\n\nI fixed it."],
      ["user", "thanks - now run tests"],
      ["assistant", "All 12 pass."],
    ])
    expect(saved.importedFrom).toMatchObject({ provider: "antigravity", id: AG_ID })
    expect(saved.title).toBe("Imported: Fix the build")
    await expect(importAntigravity(AG_ID, other, "zai")).rejects.toThrow("not found for this project")
  })

  test("offsets that do not fit the text are ignored rather than trusted", () => {
    expect(chunkSegments("abc", "[[0,0],[1,99]]", "", "nonsense").map((s) => s.text)).toEqual(["abc"])
  })
})

describe("Cursor agent CLI", () => {
  test("lists this project's chats with their names", async () => {
    expect((await listCursor(project)).sessions).toEqual([{ id: CUR_ID, title: "Dark mode", updatedAt: 1793400000 }])
    expect((await listCursor(other)).sessions).toEqual([])
  })

  test("copies what was asked and answered, without the injected context, reasoning or tools", async () => {
    const imported = await importCursor(CUR_ID, project, "zai")
    const saved = (await load(imported.id))!
    expect(saved.messages.map((m) => [m.role, m.content])).toEqual([["user", "add a dark mode"], ["assistant", "Added it in theme.ts."]])
    expect(saved.importedFrom).toMatchObject({ provider: "cursor", id: CUR_ID })
  })

  test("the pieces", () => {
    expect(cursorUserText("<user_info>x</user_info>")).toBe("")
    expect(cursorUserText("plain question")).toBe("plain question")
    expect(rootMessageIds(Buffer.from([0x0a, 2, 1, 2, 0x50, 1]))).toEqual([])
  })
})

describe("the import table", () => {
  test("both are offered to /import in either surface", () => {
    expect(importSource("antigravity")).toBe("antigravity")
    expect(importSource("agy")).toBe("antigravity")
    expect(importSource("cursor")).toBe("cursor")
    expect(IMPORTERS.antigravity.label).toBe("Antigravity")
    expect(IMPORTERS.cursor.label).toBe("Cursor")
  })
})
