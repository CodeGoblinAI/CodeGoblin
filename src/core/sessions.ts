import fs from "node:fs/promises"
import path from "node:path"
import { Global } from "../platform/paths"
import type { Message } from "./agent"
import type { Spend } from "./context"

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
  importedFrom?: { provider: string; id: string; importedAt: number }
}

const dir = path.join(Global.Path.state, "sessions")

const file = (id: string) => {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error("Invalid session ID")
  return path.join(dir, `${id}.json`)
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
  await fs.writeFile(file(session.id), JSON.stringify(session, null, 2), "utf8")
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
