import fs from "node:fs/promises"
import path from "node:path"
import { Global } from "../platform/paths"
import { CodexRpc, object } from "./codex-rpc"
import * as sessions from "./sessions"
import type { Message } from "./agent"

const idOf = (value: string) => {
  if (!/^[a-zA-Z0-9_-]{1,160}$/.test(value)) throw new Error("Invalid Codex session ID")
  return value
}
const sameProject = (a: string, b: string) => process.platform === "win32"
  ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
  : path.resolve(a) === path.resolve(b)
const label = (value: unknown) => typeof value === "string" ? value.replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 100) : "Codex conversation"

export async function listCodexSessions(root: string, cursor?: string, start = () => CodexRpc.start()) {
  const rpc = await start()
  try {
    const result = object(await rpc.call("thread/list", { cwd: path.resolve(root), limit: 20, cursor: cursor || null }))
    const found = Array.isArray(result.data) ? result.data : []
    return { sessions: found.map(object).filter((entry) => typeof entry.id === "string" && typeof entry.cwd === "string" && sameProject(entry.cwd, root)).map((entry) => ({
      id: idOf(String(entry.id)), title: label(entry.name || entry.preview),
      updatedAt: typeof entry.updatedAt === "number" && entry.updatedAt >= 0 && entry.updatedAt < 8_640_000_000_000 ? entry.updatedAt : undefined,
    })), next: typeof result.nextCursor === "string" ? result.nextCursor : undefined }
  } finally { await rpc.close() }
}

/** Text transcript only: omit native tools, reasoning, hidden prompts, paths and image bytes. */
export function importTranscript(input: unknown, root: string, provider: string): sessions.Session {
  const thread = object(object(input).thread)
  if (typeof thread.id !== "string" || typeof thread.cwd !== "string" || !sameProject(thread.cwd, root)) throw new Error("Codex conversation does not belong to this project")
  if (!Array.isArray(thread.turns)) throw new Error("Codex did not provide a readable transcript")
  const messages: Message[] = thread.turns.flatMap((turn) => {
    const items = object(turn).items
    if (!Array.isArray(items)) return []
    return items.flatMap((value): Message[] => {
      const item = object(value)
      if (item.type === "agentMessage" && typeof item.text === "string" && item.text) return [{ role: "assistant", content: item.text }]
      if (item.type !== "userMessage" || !Array.isArray(item.content)) return []
      const content = item.content.map(object).filter((part) => part.type === "text" && typeof part.text === "string").map((part) => part.text).join("\n")
      return content ? [{ role: "user", content }] : []
    })
  })
  if (!messages.length) throw new Error("No text messages to import")
  // Long conversations are the point of importing, so the bound is generous:
  // it only stops something absurd. Display and compaction handle the length.
  if (messages.length > MAX_IMPORT_MESSAGES || JSON.stringify(messages).length > MAX_IMPORT_BYTES) throw new Error("Conversation is too large to import safely")
  return { ...sessions.create(provider), id: crypto.randomUUID(), title: "Imported: " + label(thread.name || sessions.titleFrom(messages)),
    messages, importedFrom: { provider: "codex", id: idOf(thread.id), importedAt: Date.now() } }
}

const MAX_IMPORT_MESSAGES = 50_000
const MAX_IMPORT_BYTES = 128 * 1024 * 1024
/** Turns per page. Each page is one bounded RPC frame, however long the thread. */
const TURNS_PAGE = 100
const MAX_PAGES = 1000

/**
 * The whole transcript, a page of turns at a time.
 *
 * Asking for every turn in one thread/read put the entire conversation in a
 * single JSON frame - tool output and all - and long threads ran past the
 * reader's frame cap. Codex deprecates that full-history read for paged
 * threads and points at thread/turns/list, whose "summary" view carries the
 * user and agent messages its own UI shows. An older CLI without paging
 * still gets the one-shot read.
 */
async function readThread(rpc: CodexRpc, threadId: string): Promise<unknown> {
  const meta = object(object(await rpc.call("thread/read", { threadId, includeTurns: false })).thread)
  const turns: unknown[] = []
  let cursor: string | null = null
  try {
    for (let page = 0; page < MAX_PAGES; page++) {
      const result = object(await rpc.call("thread/turns/list", { threadId, limit: TURNS_PAGE, sortDirection: "asc", itemsView: "summary", cursor }))
      if (!Array.isArray(result.data)) throw new Error("No paged turns")
      turns.push(...result.data)
      cursor = typeof result.nextCursor === "string" && result.nextCursor ? result.nextCursor : null
      if (!cursor) return { thread: { ...meta, turns } }
    }
    throw new Error("Codex conversation has too many pages to import")
  } catch (error) {
    if (turns.length) throw error
    return rpc.call("thread/read", { threadId, includeTurns: true })
  }
}

export async function importCodexSession(id: string, root: string, provider: string, start = () => CodexRpc.start()) {
  idOf(id)
  const rpc = await start()
  try {
    const raw = await readThread(rpc, idOf(id))
    const session = importTranscript(raw, root, provider)
    if (session.importedFrom?.id !== id) throw new Error("Codex returned a different conversation")
    const dir = path.join(Global.Path.state, "sessions")
    await fs.mkdir(dir, { recursive: true })
    // Exclusive create, even on an improbable UUID collision. Never overwrite an existing session.
    await fs.writeFile(path.join(dir, session.id + ".json"), JSON.stringify(session, null, 2), { flag: "wx", mode: 0o600 })
    return { id: session.id, title: session.title, messages: session.messages.length }
  } finally { await rpc.close() }
}
