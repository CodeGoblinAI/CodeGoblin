import fs from "node:fs"
import fsp from "node:fs/promises"
import path from "node:path"
import { Database } from "bun:sqlite"
import { Global } from "../platform/paths"
import * as sessions from "./sessions"
import type { Message } from "./agent"

/**
 * Conversations from CodeGoblin 0.3 (the version built on the OpenCode fork),
 * copied in as text.
 *
 * 0.3 kept every conversation in one database, codegoblin.db, in the data
 * folder this version shares with it. Nothing here writes to that database:
 * it is opened read-only, so 0.3 keeps working beside this version and a
 * person can go back to it with everything still there.
 *
 * Like the other importers: this project's conversations only, a new session
 * with provenance, and only what was said. Tool calls and their output,
 * reasoning, pasted images and the text the app wrote into a turn on its own
 * are left out. Conversations a subagent had are not offered - they were never
 * something the person opened.
 */
export const forkDatabase = () => process.env.CG_FORK_DB || path.join(Global.Path.data, "codegoblin.db")

const same = (a: string, b: string) => (process.platform === "win32" ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b))
const label = (value: unknown) => (typeof value === "string" && value.trim() ? value.replace(/[\x00-\x1f\x7f]/g, " ").trim().slice(0, 100) : "CodeGoblin conversation")
const ID = /^ses_[A-Za-z0-9]{8,60}$/
const PAGE = 20
const MAX_MESSAGES = 50_000
const MAX_BYTES = 128 * 1024 * 1024

function open(): Database | undefined {
  const file = forkDatabase()
  if (!fs.existsSync(file)) return undefined
  try { return new Database(file, { readonly: true }) } catch { return undefined }
}

type Row = { id: string; title: string; directory: string; updated: number }

/** This project's conversations, newest first. An unreadable or differently shaped database offers nothing rather than failing. */
function mine(db: Database, root: string): Row[] {
  try {
    const rows = db.query("select id, title, directory, time_updated as updated from session where parent_id is null and time_archived is null order by time_updated desc").all() as Row[]
    return rows.filter((row) => typeof row.id === "string" && ID.test(row.id) && typeof row.directory === "string" && same(row.directory, root))
  } catch {
    return []
  }
}

export async function listFork(root: string, cursor?: string) {
  const db = open()
  if (!db) return { sessions: [] }
  try {
    const found = mine(db, root)
    const offset = cursor && /^\d{1,6}$/.test(cursor) ? Number(cursor) : 0
    return {
      sessions: found.slice(offset, offset + PAGE).map((row) => ({ id: row.id, title: label(row.title), updatedAt: Number.isFinite(row.updated) ? Math.floor(row.updated / 1000) : undefined })),
      next: found.length > offset + PAGE ? String(offset + PAGE) : undefined,
    }
  } finally {
    db.close()
  }
}

const parse = (text: unknown): Record<string, unknown> => {
  try {
    const value = JSON.parse(String(text))
    return value && typeof value === "object" ? value as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

/**
 * One conversation's messages, in order, as what was said.
 *
 * 0.3 stores a turn as many assistant messages - one per step, most of them
 * only tool calls - so consecutive text from the same side is one message
 * here, the way it read on screen.
 */
export function forkTranscript(db: Database, id: string): Message[] {
  const rows = db.query("select m.id as message, m.data as info, m.time_created as at, p.data as part from message m left join part p on p.message_id = m.id where m.session_id = ? order by m.time_created, m.id, p.id").all(id) as { message: string; info: string; at: number; part: string | null }[]
  const messages: Message[] = []
  let role: unknown
  let current: string | undefined
  for (const row of rows) {
    if (row.message !== current) { current = row.message; role = parse(row.info).role }
    if ((role !== "user" && role !== "assistant") || !row.part) continue
    const part = parse(row.part)
    // `synthetic` is text the app added to a turn itself; `ignored` was never sent.
    if (part.type !== "text" || typeof part.text !== "string" || part.synthetic || part.ignored) continue
    const text = part.text.trim()
    if (!text) continue
    const last = messages.at(-1)
    if (last && last.role === role) last.content += "\n\n" + text
    else messages.push({ role, content: text, ...(Number.isFinite(row.at) ? { at: row.at } : {}) })
  }
  return messages
}

export async function importFork(id: string, root: string, provider: string) {
  if (!ID.test(id)) throw new Error("Invalid CodeGoblin conversation ID")
  const db = open()
  if (!db) throw new Error("No CodeGoblin 0.3 conversations found on this computer")
  let messages: Message[]
  let listed: Row | undefined
  try {
    listed = mine(db, root).find((row) => row.id === id)
    if (!listed) throw new Error("CodeGoblin conversation not found for this project")
    messages = forkTranscript(db, id)
  } finally {
    db.close()
  }
  if (!messages.length) throw new Error("No text messages to import")
  if (messages.length > MAX_MESSAGES || JSON.stringify(messages).length > MAX_BYTES) throw new Error("Conversation is too large to import safely")
  const session: sessions.Session = {
    ...sessions.create(provider, undefined, root), id: crypto.randomUUID(), title: "Imported: " + label(listed.title), messages,
    importedFrom: { provider: "codegoblin", id, importedAt: Date.now() },
  }
  const store = path.join(Global.Path.state, "sessions")
  await fsp.mkdir(store, { recursive: true })
  // Exclusive create: an import never overwrites a conversation.
  await fsp.writeFile(path.join(store, session.id + ".json"), JSON.stringify(session, null, 2), { flag: "wx", mode: 0o600 })
  return { id: session.id, title: session.title, messages: messages.length }
}
