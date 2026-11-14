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
  /** Set on a copy made with /fork: the conversation it branched from. */
  forkedFrom?: { id: string; at: number }
  /** The folder it was working in; older conversations do not say. */
  root?: string
  /** Kept at the top of the conversation list. */
  pinned?: boolean
  /** MCP servers switched off for this conversation (/mcp). */
  mcpOff?: string[]
  /** Set when the conversation was compacted while idle: when, and the estimated dollars saved. Shown once it is next opened. */
  idleCompacted?: { at: number; saving: number }
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

/**
 * /fork: the conversation so far as a new session, saved, to carry on in.
 *
 * The original is left exactly as it was, so trying another direction costs
 * nothing. Edit history and activity stay behind - undo in the copy must not
 * take back the original's changes - and spend starts again. The compaction
 * archive comes along, so /export of the copy still has every word.
 */
export async function fork(source: Session): Promise<Session> {
  const now = Date.now()
  const copy: Session = {
    id: crypto.randomUUID(), title: ("Fork: " + source.title.replace(/^Fork: /, "")).slice(0, 120), created: now, updated: now,
    provider: source.provider, ...(source.model ? { model: source.model } : {}), ...(source.agent ? { agent: source.agent } : {}),
    messages: structuredClone(source.messages), forkedFrom: { id: source.id, at: now },
  }
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(file(copy.id), JSON.stringify(copy, null, 2), { flag: "wx", mode: 0o600 })
  if (await hasArchive(source.id)) await fs.copyFile(archiveFile(source.id), archiveFile(copy.id))
  return copy
}

/** The most recent answer worth copying: the last assistant message with words in it. */
export const lastAnswer = (messages: Message[]) => [...messages].reverse().find((message) => message.role === "assistant" && message.content.trim())?.content

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
  // A `!command` is not what the conversation is about: wait for the first real prompt.
  const found = messages.find((message) => message.role === "user" && !message.typed)
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

/** "14:05", or "Oct 30 14:05" for another day - when a message was written. */
export function clockTime(ms: number, now = Date.now()): string {
  const at = new Date(ms)
  const time = String(at.getHours()).padStart(2, "0") + ":" + String(at.getMinutes()).padStart(2, "0")
  const today = new Date(now)
  if (at.toDateString() === today.toDateString()) return time
  return at.toLocaleString("en-US", { month: "short", day: "numeric" }) + " " + time
}

/** Stamps the messages a turn added, so /timestamps has something to show after a resume. */
export function stampNew(messages: { at?: number }[], from: number, now = Date.now()) {
  for (const message of messages.slice(from)) message.at ??= now
}

/**
 * A long paste, folded to a token in the composer the way the fork shows it:
 * "[Pasted ~42 lines]", with " #2" when another paste of the same length is
 * already waiting, so two never expand to the same text.
 */
export const PASTE_FOLD_LINES = 4
export type Paste = { token: string; text: string }
const PASTE_TOKEN = /^\[Pasted ~\d+ lines(?: #\d+)?\]$/

export function pasteToken(text: string, waiting: Paste[]): string | undefined {
  const lines = text.split(String.fromCharCode(10)).length
  if (lines < PASTE_FOLD_LINES) return undefined
  const base = `[Pasted ~${lines} lines]`
  if (!waiting.some((paste) => paste.token === base)) return base
  let n = 2
  while (waiting.some((paste) => paste.token === `[Pasted ~${lines} lines #${n}]`)) n++
  return `[Pasted ~${lines} lines #${n}]`
}

/** The real text back in place of each token, for the model rather than the screen. Junk tokens are ignored. */
export function unfoldPastes(text: string, pastes: unknown): string {
  if (!Array.isArray(pastes)) return text
  let out = text
  for (const paste of pastes.slice(0, 20)) {
    if (!paste || typeof paste.token !== "string" || typeof paste.text !== "string" || !PASTE_TOKEN.test(paste.token) || paste.text.length > 2_000_000) continue
    out = out.split(paste.token).join(paste.text)
  }
  return out
}

/**
 * How long a turn took, the way the fork's "worked for" line says it:
 * "0.8s", "12s", "3m 05s", "1h 02m".
 */
export function workedFor(ms: number): string {
  if (ms < 10_000) return (Math.max(0, ms) / 1000).toFixed(1) + "s"
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return seconds + "s"
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return minutes + "m " + String(seconds % 60).padStart(2, "0") + "s"
  return Math.floor(minutes / 60) + "h " + String(minutes % 60).padStart(2, "0") + "m"
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

/**
 * Saved conversations, newest first. Given a folder, only that project's -
 * and older conversations that never recorded one, so nothing goes missing.
 */
export async function list(limit = 30, root?: string): Promise<Session[]> {
  const same = (a: string, b: string) => (process.platform === "win32" ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b))
  try {
    const names = await fs.readdir(dir)
    const sessions = await Promise.all(
      names.filter((name) => name.endsWith(".json")).map((name) => load(name.replace(/\.json$/, ""))),
    )
    return sessions
      .filter((session): session is Session => Boolean(session))
      .filter((session) => !root || !session.root || same(session.root, root))
      // Pinned conversations first, each group newest first.
      .sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || b.updated - a.updated)
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

/** Pin or unpin a conversation. Its place in time is left alone: pinning is not using it. */
export async function pin(id: string, pinned: boolean): Promise<boolean> {
  const session = await load(id)
  if (!session) return false
  if (pinned) session.pinned = true
  else delete session.pinned
  await fs.writeFile(file(id), JSON.stringify(session, null, 2), "utf8")
  return true
}

export function create(provider: string, model?: string, root: string = process.cwd()): Session {
  return {
    id: newSessionId(),
    title: "New session",
    created: Date.now(),
    updated: Date.now(),
    provider,
    model,
    messages: [],
    root,
  }
}
