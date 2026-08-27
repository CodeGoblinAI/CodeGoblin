import fs from "node:fs/promises"
import path from "node:path"
import { Global } from "../platform/paths"
import type { Message } from "./agent"

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
  messages: Message[]
}

const dir = path.join(Global.Path.state, "sessions")

const file = (id: string) => path.join(dir, `${id}.json`)

/** Sortable and unique without pulling in a uuid dependency. */
export function newSessionId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/** First user line, trimmed - enough to recognise a session in a list. */
export function titleFrom(messages: Message[]): string {
  const first = messages.find((message) => message.role === "user")?.content ?? ""
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

export function create(provider: string): Session {
  return {
    id: newSessionId(),
    title: "New session",
    created: Date.now(),
    updated: Date.now(),
    provider,
    messages: [],
  }
}
