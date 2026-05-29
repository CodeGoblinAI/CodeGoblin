import { and, desc, eq, isNull, like, or } from "drizzle-orm"
import { Database } from "../storage/db"
import { Identifier } from "../id/id"
import { MemoryEntryTable } from "./memory.sql"
import { scanMemoryContent } from "./memory-guard"

export type CodeGoblinMemoryScope = "user" | "project" | "session"

export type CodeGoblinMemoryEntry = {
  id: string
  scope: CodeGoblinMemoryScope
  projectID?: string
  sourceSessionID?: string
  content: string
  tags: string[]
  pinned: boolean
  archived: boolean
  timeCreated: number
  timeUpdated: number
}

export type CodeGoblinMemoryStatus = {
  total: number
  active: number
  archived: number
  pinned: number
  byScope: Record<CodeGoblinMemoryScope, number>
}

export type CodeGoblinMemoryListInput = {
  scope?: CodeGoblinMemoryScope
  projectID?: string
  includeArchived?: boolean
  limit?: number
}

export type CodeGoblinMemoryAddInput = {
  scope: CodeGoblinMemoryScope
  content: string
  projectID?: string
  sourceSessionID?: string
  tags?: string[]
  pinned?: boolean
}

// Per-entry content budget, inspired by Hermes' MEMORY/USER char caps. Keeps a
// single fact from blowing up the frozen context block injected into prompts.
const MAX_CONTENT_LENGTH = 1000

export class CodeGoblinMemoryError extends Error {}

export const CodeGoblinMemory = {
  generateID() {
    return Identifier.ascending("memory")
  },

  add(input: CodeGoblinMemoryAddInput): CodeGoblinMemoryEntry {
    const content = input.content.trim()
    if (!content) throw new CodeGoblinMemoryError("Memory content cannot be empty.")
    if (content.length > MAX_CONTENT_LENGTH)
      throw new CodeGoblinMemoryError(`Memory content must be ${MAX_CONTENT_LENGTH} characters or fewer.`)
    const threat = scanMemoryContent(content)
    if (threat) throw new CodeGoblinMemoryError(`Memory rejected: ${threat}`)
    if (input.scope === "project" && !input.projectID)
      throw new CodeGoblinMemoryError("Project-scoped memory requires a project id.")

    const id = CodeGoblinMemory.generateID()
    return Database.use((db) => {
      db.insert(MemoryEntryTable)
        .values({
          id,
          scope: input.scope,
          project_id: input.scope === "project" ? (input.projectID ?? null) : null,
          source_session_id: input.sourceSessionID ?? null,
          content,
          tags: input.tags && input.tags.length ? input.tags : null,
          pinned: input.pinned ?? false,
        })
        .run()
      return decode(db.select().from(MemoryEntryTable).where(eq(MemoryEntryTable.id, id)).get()!)
    })
  },

  get(id: string): CodeGoblinMemoryEntry | undefined {
    return Database.use((db) => {
      const row = db.select().from(MemoryEntryTable).where(eq(MemoryEntryTable.id, id)).get()
      return row ? decode(row) : undefined
    })
  },

  list(input: CodeGoblinMemoryListInput = {}): CodeGoblinMemoryEntry[] {
    return Database.use((db) => {
      const filters = [
        input.scope ? eq(MemoryEntryTable.scope, input.scope) : undefined,
        input.projectID ? eq(MemoryEntryTable.project_id, input.projectID) : undefined,
        input.includeArchived ? undefined : isNull(MemoryEntryTable.time_archived),
      ].filter((item): item is NonNullable<typeof item> => Boolean(item))
      const base = db
        .select()
        .from(MemoryEntryTable)
        .where(filters.length ? and(...filters) : undefined)
        .orderBy(desc(MemoryEntryTable.pinned), desc(MemoryEntryTable.time_updated))
      const rows = input.limit ? base.limit(input.limit).all() : base.all()
      return rows.map(decode)
    })
  },

  // Lightweight substring recall (no embeddings) — surfaces the most relevant
  // facts for the current task without needing a vector store.
  search(query: string, input: CodeGoblinMemoryListInput = {}): CodeGoblinMemoryEntry[] {
    const needle = query.trim()
    if (!needle) return CodeGoblinMemory.list(input)
    const terms = needle
      .toLowerCase()
      .split(/\s+/)
      .filter((term) => term.length >= 3)
      .slice(0, 6)
    if (terms.length === 0) return CodeGoblinMemory.list(input)
    return Database.use((db) => {
      const scopeFilters = [
        input.scope ? eq(MemoryEntryTable.scope, input.scope) : undefined,
        input.projectID ? eq(MemoryEntryTable.project_id, input.projectID) : undefined,
        input.includeArchived ? undefined : isNull(MemoryEntryTable.time_archived),
      ].filter((item): item is NonNullable<typeof item> => Boolean(item))
      const termFilter = or(...terms.map((term) => like(MemoryEntryTable.content, `%${term}%`)))
      const where = [...scopeFilters, termFilter].filter(
        (item): item is NonNullable<typeof item> => Boolean(item),
      )
      const base = db
        .select()
        .from(MemoryEntryTable)
        .where(where.length ? and(...where) : undefined)
        .orderBy(desc(MemoryEntryTable.pinned), desc(MemoryEntryTable.time_updated))
      const rows = input.limit ? base.limit(input.limit).all() : base.all()
      return rows.map(decode)
    })
  },

  remove(id: string): boolean {
    return Database.use((db) => {
      const existing = db.select().from(MemoryEntryTable).where(eq(MemoryEntryTable.id, id)).get()
      if (!existing) return false
      db.update(MemoryEntryTable).set({ time_archived: Date.now() }).where(eq(MemoryEntryTable.id, id)).run()
      return true
    })
  },

  restore(id: string): boolean {
    return Database.use((db) => {
      const existing = db.select().from(MemoryEntryTable).where(eq(MemoryEntryTable.id, id)).get()
      if (!existing) return false
      db.update(MemoryEntryTable).set({ time_archived: null }).where(eq(MemoryEntryTable.id, id)).run()
      return true
    })
  },

  setPinned(id: string, pinned: boolean): boolean {
    return Database.use((db) => {
      const existing = db.select().from(MemoryEntryTable).where(eq(MemoryEntryTable.id, id)).get()
      if (!existing) return false
      db.update(MemoryEntryTable).set({ pinned }).where(eq(MemoryEntryTable.id, id)).run()
      return true
    })
  },

  status(): CodeGoblinMemoryStatus {
    return Database.use((db) => {
      const rows = db.select().from(MemoryEntryTable).all().map(decode)
      const byScope: Record<CodeGoblinMemoryScope, number> = { user: 0, project: 0, session: 0 }
      for (const row of rows) byScope[row.scope] += 1
      return {
        total: rows.length,
        active: rows.filter((row) => !row.archived).length,
        archived: rows.filter((row) => row.archived).length,
        pinned: rows.filter((row) => row.pinned && !row.archived).length,
        byScope,
      }
    })
  },
}

function decode(row: typeof MemoryEntryTable.$inferSelect): CodeGoblinMemoryEntry {
  return {
    id: row.id,
    scope: normalizeScope(row.scope),
    projectID: row.project_id ?? undefined,
    sourceSessionID: row.source_session_id ?? undefined,
    content: row.content,
    tags: row.tags ?? [],
    pinned: row.pinned,
    archived: row.time_archived !== null,
    timeCreated: row.time_created,
    timeUpdated: row.time_updated,
  }
}

function normalizeScope(scope: string): CodeGoblinMemoryScope {
  if (scope === "user" || scope === "project" || scope === "session") return scope
  return "user"
}
