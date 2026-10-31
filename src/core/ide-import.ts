import fs from "node:fs"
import fsp from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Database } from "bun:sqlite"
import { Global } from "../platform/paths"
import * as sessions from "./sessions"
import type { Message } from "./agent"

/**
 * Antigravity and Cursor (agent CLI) conversations, copied in as text - the
 * fork's external-session access. Like /import codex and /import claude:
 * this project's conversations only, a new session with provenance, the
 * source opened read-only and never changed, and only what was said - no
 * tool calls or results, no reasoning, none of the context the app injects
 * into the user's side.
 *
 * Neither app documents its store, so both readers are defensive: a
 * conversation whose store cannot be read is left out of the list rather
 * than half-imported.
 *
 * - Antigravity keeps a plain-text search index of every conversation
 *   (conversation_summaries.db): user and agent text per chunk, with
 *   [step, byte offset] lists that put the turns back in order.
 * - Cursor's agent CLI keeps each chat as JSON messages in store.db, linked
 *   in order by a root record (a list of message ids).
 */
export const antigravityDir = () => process.env.CG_ANTIGRAVITY_DIR || path.join(os.homedir(), ".gemini", "antigravity")
export const cursorChatsDir = () => process.env.CG_CURSOR_CHATS_DIR || path.join(os.homedir(), ".cursor", "chats")

const same = (a: string, b: string) => (process.platform === "win32" ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b))
const label = (value: unknown, fallback: string) => (typeof value === "string" && value.trim() ? value.replace(/[\x00-\x1f\x7f]/g, " ").trim().slice(0, 100) : fallback)
const PAGE = 20
const MAX_MESSAGES = 50_000
const MAX_BYTES = 128 * 1024 * 1024

/** file:///C:/Users/x/proj or file:///c%3A/Users/x/proj, as a path. */
function uriPath(uri: string): string | undefined {
  if (!uri.startsWith("file://")) return undefined
  try {
    let decoded = decodeURIComponent(uri.slice("file://".length))
    if (/^\/[A-Za-z]:/.test(decoded)) decoded = decoded.slice(1)
    return decoded
  } catch {
    return undefined
  }
}

function open(file: string): Database | undefined {
  try { return new Database(file, { readonly: true }) } catch { return undefined }
}

function merge(messages: Message[], role: "user" | "assistant", text: string) {
  const clean = text.trim()
  if (!clean) return
  const last = messages.at(-1)
  if (last && last.role === role) last.content += "\n\n" + clean
  else messages.push({ role, content: clean })
}

async function save(title: string, messages: Message[], provider: string, from: { provider: string; id: string }) {
  if (!messages.length) throw new Error("No text messages to import")
  if (messages.length > MAX_MESSAGES || JSON.stringify(messages).length > MAX_BYTES) throw new Error("Conversation is too large to import safely")
  const session: sessions.Session = {
    ...sessions.create(provider), id: crypto.randomUUID(), title: "Imported: " + title, messages, importedFrom: { ...from, importedAt: Date.now() },
  }
  const store = path.join(Global.Path.state, "sessions")
  await fsp.mkdir(store, { recursive: true })
  await fsp.writeFile(path.join(store, session.id + ".json"), JSON.stringify(session, null, 2), { flag: "wx", mode: 0o600 })
  return { id: session.id, title: session.title, messages: messages.length }
}

// ---------- Antigravity ----------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function listAntigravity(root: string, cursor?: string) {
  const db = open(path.join(antigravityDir(), "conversation_summaries.db"))
  if (!db) return { sessions: [] }
  try {
    // Only conversations Antigravity has indexed have their text here; the others cannot be copied, so they are not offered.
    const rows = db.query("select conversation_id as id, title, preview, workspace_uris as ws, last_modified_time as at, parent_conversation_id as parent from conversation_summaries s where exists (select 1 from conversations_fts_content f where f.c0 = s.conversation_id and (length(f.c13) > 0 or length(f.c14) > 0)) order by last_modified_time desc").all() as { id: string; title: string; preview: string; ws: string; at: string; parent: string }[]
    const mine = rows.filter((row) => {
      if (!UUID.test(row.id) || row.parent) return false
      let uris: unknown
      try { uris = JSON.parse(row.ws || "[]") } catch { return false }
      return Array.isArray(uris) && uris.some((uri) => typeof uri === "string" && uriPath(uri) !== undefined && same(uriPath(uri)!, root))
    })
    const offset = cursor && /^\d{1,6}$/.test(cursor) ? Number(cursor) : 0
    return {
      sessions: mine.slice(offset, offset + PAGE).map((row) => ({ id: row.id, title: label(row.title || row.preview, "Antigravity conversation"), updatedAt: Number.isFinite(Date.parse(row.at)) ? Math.floor(Date.parse(row.at) / 1000) : undefined })),
      next: mine.length > offset + PAGE ? String(offset + PAGE) : undefined,
    }
  } finally {
    db.close()
  }
}

type Segment = { step: number; role: "user" | "assistant"; text: string }

/** One chunk of the index back into ordered segments: each [step, byteOffset] starts a step's text. */
export function chunkSegments(userBody: string, userOffsets: string, agentBody: string, agentOffsets: string): Segment[] {
  const segments: Segment[] = []
  const split = (body: string, offsets: string, role: Segment["role"]) => {
    let pairs: unknown
    try { pairs = JSON.parse(offsets || "[]") } catch { return }
    if (!Array.isArray(pairs)) return
    const bytes = Buffer.from(body, "utf8")
    const marks = pairs.filter((pair): pair is [number, number] => Array.isArray(pair) && Number.isInteger(pair[0]) && Number.isInteger(pair[1]) && pair[1] >= 0 && pair[1] <= bytes.length)
    for (const [index, [step, start]] of marks.entries()) {
      const end = marks[index + 1]?.[1] ?? bytes.length
      if (end > start) segments.push({ step, role, text: bytes.subarray(start, end).toString("utf8") })
    }
  }
  split(userBody, userOffsets, "user")
  split(agentBody, agentOffsets, "assistant")
  return segments
}

export async function importAntigravity(id: string, root: string, provider: string) {
  if (!UUID.test(id)) throw new Error("Invalid Antigravity conversation ID")
  const listed = (await listAll(listAntigravity, root)).find((entry) => entry.id === id)
  if (!listed) throw new Error("Antigravity conversation not found for this project")
  const db = open(path.join(antigravityDir(), "conversation_summaries.db"))
  if (!db) throw new Error("Antigravity's conversation index cannot be read")
  let segments: Segment[]
  try {
    const rows = db.query("select c8 as uo, c9 as ao, c13 as ub, c14 as ab from conversations_fts_content where c0 = ? order by c1").all(id) as Record<string, unknown>[]
    // The offset lists are stored as blobs holding JSON text, the bodies as text; either may arrive as bytes.
    const text = (value: unknown) => (typeof value === "string" ? value : value instanceof Uint8Array ? Buffer.from(value).toString("utf8") : "")
    segments = rows.flatMap((row) => chunkSegments(text(row.ub), text(row.uo), text(row.ab), text(row.ao)))
  } finally {
    db.close()
  }
  const messages: Message[] = []
  for (const segment of segments.sort((a, b) => a.step - b.step)) merge(messages, segment.role, segment.text)
  return save(listed.title, messages, provider, { provider: "antigravity", id })
}

// ---------- Cursor agent CLI ----------

type CursorChat = { id: string; dir: string; title: string; updatedAt?: number }

function cursorChats(root: string): CursorChat[] {
  const chats: CursorChat[] = []
  let projects: string[]
  try { projects = fs.readdirSync(cursorChatsDir()) } catch { return [] }
  for (const project of projects) {
    let ids: string[]
    try { ids = fs.readdirSync(path.join(cursorChatsDir(), project)) } catch { continue }
    for (const id of ids) {
      if (!UUID.test(id)) continue
      const dir = path.join(cursorChatsDir(), project, id)
      let meta: { cwd?: unknown; updatedAtMs?: unknown }
      try { meta = JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf8")) } catch { continue }
      if (typeof meta.cwd !== "string" || !same(meta.cwd, root) || !fs.existsSync(path.join(dir, "store.db"))) continue
      const db = open(path.join(dir, "store.db"))
      if (!db) continue
      let title = "Cursor conversation"
      try {
        const row = db.query("select value from meta where key = '0'").get() as { value?: string } | null
        const info = row?.value ? JSON.parse(Buffer.from(row.value, "hex").toString("utf8")) as { name?: unknown } : {}
        title = label(info.name, title)
      } catch { db.close(); continue }
      db.close()
      chats.push({ id, dir, title, updatedAt: typeof meta.updatedAtMs === "number" ? Math.floor(meta.updatedAtMs / 1000) : undefined })
    }
  }
  return chats.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
}

export async function listCursor(root: string, cursor?: string) {
  const mine = cursorChats(root)
  const offset = cursor && /^\d{1,6}$/.test(cursor) ? Number(cursor) : 0
  return { sessions: mine.slice(offset, offset + PAGE).map(({ id, title, updatedAt }) => ({ id, title, updatedAt })), next: mine.length > offset + PAGE ? String(offset + PAGE) : undefined }
}

/** The message ids a root record lists, in order: repeated field 1, 32 bytes each. */
export function rootMessageIds(root: Uint8Array): string[] {
  const ids: string[] = []
  let at = 0
  while (at < root.length) {
    const tag = root[at++]!
    const wire = tag & 7
    if (wire === 2) {
      let length = 0, shift = 0, byte: number
      do { byte = root[at++] ?? 0; length |= (byte & 127) << shift; shift += 7 } while (byte & 128 && shift < 35)
      if (tag >> 3 === 1 && length === 32) ids.push(Buffer.from(root.subarray(at, at + 32)).toString("hex"))
      at += length
    } else if (wire === 0) {
      while ((root[at++] ?? 0) & 128 && at < root.length);
    } else break
  }
  return ids
}

/** What the person typed, from a user message: the <user_query>, without the context Cursor wraps around it. */
export function cursorUserText(content: unknown): string {
  const texts = typeof content === "string" ? [content] : Array.isArray(content) ? content.filter((part) => part?.type === "text" && typeof part.text === "string").map((part) => String(part.text)) : []
  const out: string[] = []
  for (const text of texts) {
    const queries = [...text.matchAll(/<user_query>([\s\S]*?)<\/user_query>/g)].map((match) => match[1]!.trim()).filter(Boolean)
    if (queries.length) out.push(...queries)
    else if (!/^\s*</.test(text)) out.push(text.trim())
  }
  return out.filter(Boolean).join("\n\n")
}

function cursorAssistantText(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content.filter((part) => part?.type === "text" && typeof part.text === "string").map((part) => String(part.text).trim()).filter(Boolean).join("\n\n")
}

export async function importCursor(id: string, root: string, provider: string) {
  if (!UUID.test(id)) throw new Error("Invalid Cursor conversation ID")
  const chat = cursorChats(root).find((entry) => entry.id === id)
  if (!chat) throw new Error("Cursor conversation not found for this project")
  const db = open(path.join(chat.dir, "store.db"))
  if (!db) throw new Error("Cursor's store for that conversation cannot be read")
  const messages: Message[] = []
  try {
    const metaRow = db.query("select value from meta where key = '0'").get() as { value: string }
    const meta = JSON.parse(Buffer.from(metaRow.value, "hex").toString("utf8")) as { latestRootBlobId?: unknown }
    const rootBlob = typeof meta.latestRootBlobId === "string" ? db.query("select data from blobs where id = ?").get(meta.latestRootBlobId) as { data: Uint8Array } | null : null
    if (!rootBlob) throw new Error("Cursor's store has no conversation in it")
    const get = db.query("select data from blobs where id = ?")
    for (const messageId of rootMessageIds(rootBlob.data)) {
      const row = get.get(messageId) as { data: Uint8Array } | null
      if (!row) continue
      let message: { role?: unknown; content?: unknown }
      try { message = JSON.parse(Buffer.from(row.data).toString("utf8")) } catch { continue }
      if (message.role === "user") merge(messages, "user", cursorUserText(message.content))
      else if (message.role === "assistant") merge(messages, "assistant", cursorAssistantText(message.content))
    }
  } finally {
    db.close()
  }
  return save(chat.title, messages, provider, { provider: "cursor", id })
}

/** Every page of a listing, for looking one conversation up. */
async function listAll(list: (root: string, cursor?: string) => Promise<{ sessions: { id: string; title: string }[]; next?: string }>, root: string) {
  const all: { id: string; title: string }[] = []
  let cursor: string | undefined
  for (let page = 0; page < 500; page++) {
    const listed = await list(root, cursor)
    all.push(...listed.sessions)
    if (!listed.next) break
    cursor = listed.next
  }
  return all
}
