import fs from "node:fs/promises"
import path from "node:path"
import { Global } from "../platform/paths"
import { scanMemoryContent } from "../domain/memory-guard"

/**
 * Things worth remembering between conversations.
 *
 * A file, not a database. The original keeps these in SQLite through an ORM,
 * which is a reasonable thing for it to do and a strange thing for this to
 * adopt for one small feature - sessions are already a JSON file each, and
 * memory is a list someone reads, not a dataset anyone queries. When sessions
 * and memory and search together want an index, that is the moment for a
 * database, and this will be easy to move.
 *
 * What did come across whole is memory-guard. Stored text is fed back to the
 * model later, which makes this the one place in the app where a note someone
 * saves is indistinguishable from an instruction someone planted - so content
 * is scanned before it is ever written down.
 */

export type MemoryScope = "user" | "project" | "session"

export type MemoryEntry = {
  id: string
  scope: MemoryScope
  content: string
  /** The working directory a project-scoped memory belongs to. */
  project?: string
  /** The conversation a session-scoped memory came from. */
  session?: string
  tags: string[]
  pinned: boolean
  archived: boolean
  created: number
  updated: number
}

export class MemoryError extends Error {}

/** Long enough for a fact, short enough that nobody pastes a file in. */
export const MAX_CONTENT = 1000

/** What is read back into a conversation, per scope. */
const RECALL_LIMITS: Record<MemoryScope, number> = { user: 12, project: 12, session: 6 }

const file = path.join(Global.Path.state, "memory.json")

/**
 * Ids that sort the way the entries were made.
 *
 * Date.now() only ticks every millisecond, and adding two memories inside one
 * tick is easy - so ordering by timestamp alone left them in whatever order
 * the sort happened to produce. A counter within the millisecond settles it.
 */
let lastStamp = 0
let withinStamp = 0

function newId(): string {
  const now = Date.now()
  if (now === lastStamp) withinStamp++
  else {
    lastStamp = now
    withinStamp = 0
  }
  const stamp = now.toString(36).padStart(9, "0")
  return `mem-${stamp}-${withinStamp.toString(36).padStart(4, "0")}`
}

async function readAll(): Promise<MemoryEntry[]> {
  try {
    const parsed = JSON.parse(await fs.readFile(file, "utf8"))
    return Array.isArray(parsed) ? parsed.filter(isEntry) : []
  } catch {
    // Missing or unreadable: an empty memory is a perfectly good answer, and
    // failing to start because of it would be worse than forgetting.
    return []
  }
}

/** A file edited by hand should not be able to put nonsense into a prompt. */
function isEntry(value: unknown): value is MemoryEntry {
  if (!value || typeof value !== "object") return false
  const entry = value as Partial<MemoryEntry>
  return (
    typeof entry.id === "string" &&
    typeof entry.content === "string" &&
    (entry.scope === "user" || entry.scope === "project" || entry.scope === "session")
  )
}

async function writeAll(entries: MemoryEntry[]): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, JSON.stringify(entries, null, 2), "utf8")
}

export type AddInput = {
  scope: MemoryScope
  content: string
  project?: string
  session?: string
  tags?: string[]
  pinned?: boolean
}

export async function add(input: AddInput): Promise<MemoryEntry> {
  const content = input.content.trim()
  if (!content) throw new MemoryError("nothing to remember")
  if (content.length > MAX_CONTENT) throw new MemoryError(`too long - keep it under ${MAX_CONTENT} characters`)

  // Rejected before it is written, not before it is read: a note that reaches
  // the file would reach a prompt on some later day, when nobody is looking.
  const threat = scanMemoryContent(content)
  if (threat) throw new MemoryError(`refused: it ${threat}`)

  if (input.scope === "project" && !input.project) throw new MemoryError("a project memory needs a project")

  const now = Date.now()
  const entry: MemoryEntry = {
    id: newId(),
    scope: input.scope,
    content,
    project: input.scope === "project" ? input.project : undefined,
    session: input.session,
    tags: input.tags?.length ? input.tags : [],
    pinned: input.pinned ?? false,
    archived: false,
    created: now,
    updated: now,
  }

  const entries = await readAll()
  entries.push(entry)
  await writeAll(entries)
  return entry
}

export type ListInput = {
  scope?: MemoryScope
  project?: string
  session?: string
  includeArchived?: boolean
  query?: string
  limit?: number
}

/** Pinned first, then newest. What was marked important stays visible. */
export async function list(input: ListInput = {}): Promise<MemoryEntry[]> {
  const needle = input.query?.trim().toLowerCase()
  const matches = (await readAll()).filter((entry) => {
    if (!input.includeArchived && entry.archived) return false
    if (input.scope && entry.scope !== input.scope) return false
    if (input.project && entry.scope === "project" && entry.project !== input.project) return false
    if (input.session && entry.scope === "session" && entry.session !== input.session) return false
    if (needle && !entry.content.toLowerCase().includes(needle) && !entry.tags.some((tag) => tag.toLowerCase().includes(needle))) {
      return false
    }
    return true
  })

  // The id breaks a tie on the timestamp, since it carries the order within
  // the millisecond that created holds no room for.
  matches.sort(
    (a, b) => Number(b.pinned) - Number(a.pinned) || b.created - a.created || b.id.localeCompare(a.id),
  )
  return input.limit ? matches.slice(0, input.limit) : matches
}

export async function get(id: string): Promise<MemoryEntry | undefined> {
  return (await readAll()).find((entry) => entry.id === id)
}

/**
 * Forget one.
 *
 * Removed outright rather than archived: "forget that" should mean it is
 * gone, not that it is somewhere quieter.
 */
export async function remove(id: string): Promise<boolean> {
  const entries = await readAll()
  const next = entries.filter((entry) => entry.id !== id)
  if (next.length === entries.length) return false
  await writeAll(next)
  return true
}

export async function archive(id: string, archived = true): Promise<boolean> {
  const entries = await readAll()
  const entry = entries.find((candidate) => candidate.id === id)
  if (!entry) return false
  entry.archived = archived
  entry.updated = Date.now()
  await writeAll(entries)
  return true
}

export async function clear(scope?: MemoryScope): Promise<number> {
  const entries = await readAll()
  const kept = scope ? entries.filter((entry) => entry.scope !== scope) : []
  await writeAll(kept)
  return entries.length - kept.length
}

export type MemoryStatus = {
  total: number
  active: number
  archived: number
  pinned: number
  byScope: Record<MemoryScope, number>
}

export async function status(): Promise<MemoryStatus> {
  const entries = await readAll()
  const byScope: Record<MemoryScope, number> = { user: 0, project: 0, session: 0 }
  for (const entry of entries) byScope[entry.scope]++
  return {
    total: entries.length,
    active: entries.filter((entry) => !entry.archived).length,
    archived: entries.filter((entry) => entry.archived).length,
    pinned: entries.filter((entry) => entry.pinned).length,
    byScope,
  }
}

/**
 * What the model should be told it already knows.
 *
 * Returns undefined rather than an empty heading when there is nothing worth
 * saying - an empty section in a prompt is noise the model has to read past.
 */
export async function recall(input: { project?: string; session?: string; query?: string }): Promise<string | undefined> {
  const groups: [string, MemoryEntry[]][] = [
    ["About the user", await list({ scope: "user", query: input.query, limit: RECALL_LIMITS.user })],
    ["About this project", await list({ scope: "project", project: input.project, query: input.query, limit: RECALL_LIMITS.project })],
    ["From this conversation", await list({ scope: "session", session: input.session, limit: RECALL_LIMITS.session })],
  ]

  const written = groups.filter(([, entries]) => entries.length)
  if (!written.length) return undefined

  const NEWLINE = String.fromCharCode(10)
  return (
    "Things you already know:" +
    NEWLINE +
    written
      .map(([label, entries]) => label + NEWLINE + entries.map((entry) => "- " + entry.content).join(NEWLINE))
      .join(NEWLINE + NEWLINE)
  )
}
