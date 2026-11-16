import { afterAll, beforeAll, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { importFork, listFork } from "../src/core/fork-import"
import { IMPORTERS, importSource } from "../src/core/conversation-import"
import { load } from "../src/core/sessions"

const base = fs.mkdtempSync(path.join(os.tmpdir(), "cg-fork-import-"))
const project = path.join(base, "proj")
const other = path.join(base, "other")
const file = path.join(base, "codegoblin.db")
const MAIN = "ses_e28f45139ffewBYDiSnKwWNEeo"
const CHILD = "ses_e28f45139ffewBYDiSnKwWNEe1"
const ELSEWHERE = "ses_e28f45139ffewBYDiSnKwWNEe2"
const EMPTY = "ses_e28f45139ffewBYDiSnKwWNEe3"

/** A 0.3 database with the columns and JSON shapes it really writes. */
function fixture() {
  const db = new Database(file)
  db.run("create table session (id text primary key, project_id text, parent_id text, directory text, title text, time_created integer, time_updated integer, time_archived integer)")
  db.run("create table message (id text primary key, session_id text, time_created integer, time_updated integer, data text)")
  db.run("create table part (id text primary key, message_id text, session_id text, time_created integer, time_updated integer, data text)")
  const session = (id: string, directory: string, title: string, updated: number, parent: string | null = null) =>
    db.run("insert into session values (?, 'global', ?, ?, ?, ?, ?, null)", [id, parent, directory, title, updated, updated])
  session(MAIN, project, "Rename the helper", 1794610330150)
  session(CHILD, project, "Explore (@explore subagent)", 1794610330160, MAIN)
  session(ELSEWHERE, other, "Another project", 1794610330170)
  session(EMPTY, project, "Only tools", 1794610000000)
  let n = 0
  const message = (sessionId: string, role: string, at: number, parts: object[]) => {
    const id = "msg_" + String(++n).padStart(4, "0")
    db.run("insert into message values (?, ?, ?, ?, ?)", [id, sessionId, at, at, JSON.stringify({ role, time: { created: at } })])
    for (const part of parts) db.run("insert into part values (?, ?, ?, ?, ?, ?)", ["prt_" + String(++n).padStart(4, "0"), id, sessionId, at, at, JSON.stringify(part)])
  }
  message(MAIN, "user", 1000, [
    { type: "text", text: "rename helper to assist" },
    { type: "text", text: "<system-reminder>injected</system-reminder>", synthetic: true },
    { type: "file", mime: "image/png", url: "data:image/png;base64,AAAA" },
  ])
  // One turn is several assistant messages: a step that only calls a tool, then the answer in two steps.
  message(MAIN, "assistant", 2000, [{ type: "step-start" }, { type: "reasoning", text: "thinking it over" }, { type: "tool", tool: "bash", state: { status: "completed", output: "secret tool output" } }, { type: "step-finish" }])
  message(MAIN, "assistant", 3000, [{ type: "text", text: "Renamed it in two files." }])
  message(MAIN, "assistant", 4000, [{ type: "text", text: "Tests pass." }])
  message(MAIN, "user", 5000, [{ type: "text", text: "thanks" }])
  message(CHILD, "user", 1000, [{ type: "text", text: "explore" }])
  message(ELSEWHERE, "user", 1000, [{ type: "text", text: "elsewhere" }])
  message(EMPTY, "assistant", 1000, [{ type: "tool", tool: "bash", state: { status: "completed", output: "x" } }])
  db.close()
  process.env.CG_FORK_DB = file
}

const sha = () => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex")

beforeAll(() => { fs.mkdirSync(project, { recursive: true }); fs.mkdirSync(other, { recursive: true }); fixture() })
afterAll(() => { delete process.env.CG_FORK_DB })

test("lists this project's own conversations, newest first, without the ones a subagent had", async () => {
  const listed = await listFork(project)
  expect(listed.sessions).toEqual([
    { id: MAIN, title: "Rename the helper", updatedAt: 1794610330 },
    { id: EMPTY, title: "Only tools", updatedAt: 1794610000 },
  ])
  expect((await listFork(other)).sessions.map((entry) => entry.id)).toEqual([ELSEWHERE])
})

test("copies what was said, one message per side of a turn, and leaves the database exactly as it was", async () => {
  const before = sha()
  const imported = await importFork(MAIN, project, "zai")
  const saved = (await load(imported.id))!
  expect(saved.messages.map((message) => [message.role, message.content])).toEqual([
    ["user", "rename helper to assist"],
    ["assistant", "Renamed it in two files.\n\nTests pass."],
    ["user", "thanks"],
  ])
  expect(JSON.stringify(saved)).not.toMatch(/secret tool output|thinking it over|injected|base64/)
  expect(saved.messages[0]!.at).toBe(1000)
  expect(saved.title).toBe("Imported: Rename the helper")
  expect(saved.root).toBe(project)
  expect(saved.importedFrom).toMatchObject({ provider: "codegoblin", id: MAIN })
  expect(sha()).toBe(before)
  expect(fs.readdirSync(base).filter((name) => name.startsWith("codegoblin.db"))).toEqual(["codegoblin.db"])
})

test("refuses another project's conversation, a subagent's, one with nothing said, and a made-up id", async () => {
  await expect(importFork(ELSEWHERE, project, "zai")).rejects.toThrow("not found for this project")
  await expect(importFork(CHILD, project, "zai")).rejects.toThrow("not found for this project")
  await expect(importFork(EMPTY, project, "zai")).rejects.toThrow("No text messages")
  await expect(importFork("../../etc", project, "zai")).rejects.toThrow("Invalid")
})

test("no 0.3 database, or one in another shape, offers nothing instead of failing", async () => {
  process.env.CG_FORK_DB = path.join(base, "missing.db")
  expect(await listFork(project)).toEqual({ sessions: [] })
  await expect(importFork(MAIN, project, "zai")).rejects.toThrow("No CodeGoblin 0.3 conversations")
  const odd = path.join(base, "odd.db")
  const db = new Database(odd); db.run("create table session (id text)"); db.close()
  process.env.CG_FORK_DB = odd
  expect(await listFork(project)).toEqual({ sessions: [] })
  fs.writeFileSync(path.join(base, "junk.db"), "not a database at all")
  process.env.CG_FORK_DB = path.join(base, "junk.db")
  expect(await listFork(project)).toEqual({ sessions: [] })
  process.env.CG_FORK_DB = file
})

test("/import codegoblin reaches it from either surface", () => {
  expect(importSource("codegoblin")).toBe("codegoblin")
  expect(importSource("old")).toBe("codegoblin")
  expect(IMPORTERS.codegoblin.label).toBe("CodeGoblin 0.3")
})
