import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core"
import { Timestamps } from "../storage/schema.sql"

export const MemoryEntryTable = sqliteTable(
  "memory_entry",
  {
    id: text().primaryKey(),
    // "user" facts persist everywhere; "project" facts scope to a project; "session" facts are conversation-local.
    scope: text().notNull(),
    project_id: text(),
    source_session_id: text(),
    content: text().notNull(),
    tags: text({ mode: "json" }).$type<string[]>(),
    pinned: integer({ mode: "boolean" }).notNull().default(false),
    ...Timestamps,
    time_archived: integer(),
  },
  (table) => [
    index("memory_entry_scope_idx").on(table.scope),
    index("memory_entry_project_idx").on(table.project_id),
    index("memory_entry_archived_idx").on(table.time_archived),
  ],
)
