// Builds an Antigravity index and a Cursor chat store, in each app's shape, for a project folder. Usage: bun make-ide-fixtures.ts <base> <project>
import { Database } from "bun:sqlite"
import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
const [base, project] = process.argv.slice(2) as [string, string]
const ag = path.join(base, "antigravity")
fs.mkdirSync(ag, { recursive: true })
const db = new Database(path.join(ag, "conversation_summaries.db"))
db.run("create table conversation_summaries (conversation_id text, title text, preview text, workspace_uris text, last_modified_time text, parent_conversation_id text)")
db.run("create table conversations_fts_content (id integer primary key, c0, c1, c2, c3, c4, c5, c6, c7, c8, c9, c10, c11, c12, c13, c14)")
const id = "0790291a-0813-57a1-873f-51026b8c9f79"
db.run("insert into conversation_summaries values (?, 'Plan the release', '', ?, '2026-10-07 15:49:28.9+00:00', '')", [id, JSON.stringify(["file:///" + project.split(path.sep).join("/")])])
const user = "when do we ship?", agent = "Friday, after the tests pass."
db.run("insert into conversations_fts_content (c0, c1, c8, c9, c13, c14) values (?, 0, ?, ?, ?, ?)", [id, Buffer.from("[[0,0]]"), Buffer.from("[[1,0]]"), user, agent])
db.close()
const chat = path.join(base, "cursor", "p1", "126d19ac-cd7a-479b-bf37-ec7dde7718fc")
fs.mkdirSync(chat, { recursive: true })
fs.writeFileSync(path.join(chat, "meta.json"), JSON.stringify({ cwd: project, updatedAtMs: Date.now() }))
const store = new Database(path.join(chat, "store.db"))
store.run("create table blobs (id text primary key, data blob)")
store.run("create table meta (key text primary key, value text)")
const ids = [{ role: "user", content: [{ type: "text", text: "<timestamp>x</timestamp><user_query>rename the button</user_query>" }] }, { role: "assistant", content: [{ type: "text", text: "Renamed it to Save." }] }].map((message) => {
  const data = Buffer.from(JSON.stringify(message)); const key = crypto.createHash("sha256").update(data).digest("hex"); store.run("insert into blobs values (?, ?)", [key, data]); return key
})
const root = Buffer.concat(ids.map((key) => Buffer.concat([Buffer.from([0x0a, 32]), Buffer.from(key, "hex")])))
const rootId = crypto.createHash("sha256").update(root).digest("hex")
store.run("insert into blobs values (?, ?)", [rootId, root])
store.run("insert into meta values ('0', ?)", [Buffer.from(JSON.stringify({ latestRootBlobId: rootId, name: "Rename button" })).toString("hex")])
store.close()
console.log("ok")
