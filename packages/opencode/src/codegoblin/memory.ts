import { and, desc, eq, isNull } from "drizzle-orm"
import { Database } from "../storage/db"
import { Identifier } from "../id/id"
import { MemoryEntryTable } from "./memory.sql"

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
}

export const CodeGoblinMemory = {
  generateID() {
    return Identifier.ascending("memory")
  },
  list(input: CodeGoblinMemoryListInput = {}): CodeGoblinMemoryEntry[] {
    return Database.use((db) => {
      const filters = [
        input.scope ? eq(MemoryEntryTable.scope, input.scope) : undefined,
        input.projectID ? eq(MemoryEntryTable.project_id, input.projectID) : undefined,
        input.includeArchived ? undefined : isNull(MemoryEntryTable.time_archived),
      ].filter((item): item is NonNullable<typeof item> => Boolean(item))
      return db
        .select()
        .from(MemoryEntryTable)
        .where(filters.length ? and(...filters) : undefined)
        .orderBy(desc(MemoryEntryTable.pinned), desc(MemoryEntryTable.time_updated))
        .all()
        .map(decode)
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
