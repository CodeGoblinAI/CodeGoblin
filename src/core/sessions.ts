import fs from "node:fs/promises"
import path from "node:path"
import { Global } from "../platform/paths"
import type { Message } from "./agent"
import type { Spend } from "./context"
import type { ReviewState } from "./undo"
import type { SessionActivity } from "./session-activity"

/**
 * Sessions on disk.
 *
 * One JSON file per session under the state directory. A conversation is a
 * short list of messages, so a file per session is enough - a database can
 * come later, when search or cross-session queries actually need one.
 */
export type Session = {
  id: string
  title: string
  created: number
  updated: number
  provider: string
  /** Last model actually used; omitted on older conversations. */
  model?: string
  /** Named profile actually used; missing/deleted profiles must be chosen again. */
  agent?: string
  messages: Message[]
  spend?: Spend
  review?: ReviewState
  activity?: SessionActivity
  importedFrom?: { provider: string; id: string; importedAt: number }
}

const dir = path.join(Global.Path.state, "sessions")
const NEWLINE = String.fromCharCode(10)

const file = (id: string) => {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error("Invalid session ID")
  return path.join(dir, `${id}.json`)
}

/**
 * Messages compaction replaced, oldest first, one JSON message per line.
 *
 * Compaction swaps old history for a summary so the model can keep going;
 * the words themselves are not thrown away. They live here, beside the
 * session rather than inside it, so opening or listing a long conversation
 * never has to read them - only /export does.
 */
const archiveFile = (id: string) => file(id).replace(/\.json$/, ".archive.jsonl")

export async function appendArchive(id: string, messages: Message[]): Promise<void> {
  if (!messages.length) return
  await fs.mkdir(dir, { recursive: true })
  await fs.appendFile(archiveFile(id), messages.map((message) => JSON.stringify(message)).join(NEWLINE) + NEWLINE, { encoding: "utf8", mode: 0o600 })
}

export async function hasArchive(id: string): Promise<boolean> {
  try {
    return (await fs.stat(archiveFile(id))).size > 0
  } catch {
    return false
  }
}

/** How many messages a person reads on screen before older ones are left out. */
export const DISPLAY_MESSAGES = 200

const readable = (message: Message) => message.role === "user" || (message.role === "assistant" && Boolean(message.content))

/**
 * The recent end of a long conversation, for drawing.
 *
 * An imported or long-running conversation can run to thousands of messages;
 * drawing all of them makes every keystroke and stream token pay for the
 * lot, and sending them all to the browser is megabytes nobody scrolls to.
 * The model still gets its own context and the export still gets every
 * word - this only decides what is drawn. `hidden` counts readable
 * messages left out, so the surfaces can say so and point at /export.
 */
export function displayWindow(messages: Message[], limit = DISPLAY_MESSAGES): { messages: Message[]; hidden: number } {
  let seen = 0
  let start = messages.length
  while (start > 0) {
    const message = messages[start - 1]!
    if (readable(message)) {
      if (seen === limit) break
      seen++
    }
    start--
  }
  // Never open on a tool result whose call was left out.
  while (start < messages.length && messages[start]!.role === "tool") start++
  if (!start) return { messages, hidden: 0 }
  return { messages: messages.slice(start), hidden: messages.slice(0, start).filter(readable).length }
}

export async function loadArchive(id: string): Promise<Message[]> {
  let text: string
  try {
    text = await fs.readFile(archiveFile(id), "utf8")
  } catch {
    return []
  }
  const out: Message[] = []
  for (const line of text.split(NEWLINE)) {
    if (!line.trim()) continue
    // A torn last line from an interrupted append is skipped, not fatal.
    try { out.push(JSON.parse(line) as Message) } catch {}
  }
  return out
}

/** Sortable and unique without pulling in a uuid dependency. */
export function newSessionId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/** First user line, trimmed - enough to recognise a session in a list. */
export function titleFrom(messages: Message[]): string {
  const found = messages.find((message) => message.role === "user")
  const first = found?.display ?? found?.content ?? ""
  const line = first.split(String.fromCharCode(10))[0] ?? ""
  return line.length > 48 ? line.slice(0, 48) + "…" : line || "New session"
}

export async function save(session: Session): Promise<void> {
  await fs.mkdir(dir, { recursive: true })
  session.updated = Date.now()
  session.title = session.title === "New session" ? titleFrom(session.messages) : session.title
  const target = file(session.id)
  const temporary = target + "." + newSessionId() + ".tmp"
  await fs.writeFile(temporary, JSON.stringify(session, null, 2), { encoding: "utf8", mode: 0o600 })
  await fs.rename(temporary, target)
}

export async function load(id: string): Promise<Session | undefined> {
  try {
    return JSON.parse(await fs.readFile(file(id), "utf8")) as Session
  } catch {
    return undefined
  }
}

/**
 * How long ago, in the web sidebar's words: "just now", "5m", "3h", "2d".
 * Conversations often share a title ("fix the test"), and the age is what
 * tells them apart in a picker.
 */
export function ago(ms: number, now = Date.now()): string {
  const seconds = Math.round((now - ms) / 1000)
  if (seconds < 60) return "just now"
  if (seconds < 3600) return Math.round(seconds / 60) + "m"
  if (seconds < 86400) return Math.round(seconds / 3600) + "h"
  return Math.round(seconds / 86400) + "d"
}

export async function list(limit = 30): Promise<Session[]> {
  try {
    const names = await fs.readdir(dir)
    const sessions = await Promise.all(
      names.filter((name) => name.endsWith(".json")).map((name) => load(name.replace(/\.json$/, ""))),
    )
    return sessions
      .filter((session): session is Session => Boolean(session))
      .sort((a, b) => b.updated - a.updated)
      .slice(0, limit)
  } catch {
    return []
  }
}

export async function remove(id: string): Promise<boolean> {
  try {
    await fs.unlink(file(id))
    await fs.unlink(archiveFile(id)).catch(() => {})
    return true
  } catch {
    return false
  }
}

export async function rename(id: string, title: string): Promise<boolean> {
  const session = await load(id)
  if (!session) return false
  session.title = title.slice(0, 80)
  await fs.writeFile(file(id), JSON.stringify(session, null, 2), "utf8")
  return true
}

export function create(provider: string, model?: string): Session {
  return {
    id: newSessionId(),
    title: "New session",
    created: Date.now(),
    updated: Date.now(),
    provider,
    model,
    messages: [],
  }
}
