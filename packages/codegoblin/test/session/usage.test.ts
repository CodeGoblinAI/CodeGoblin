import { expect, test } from "bun:test"
import { inArray } from "drizzle-orm"
import { Database } from "@/storage/db"
import { ProjectTable } from "@/project/project.sql"
import { ProjectID } from "@/project/schema"
import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import { SessionTable } from "@/session/session.sql"

test("session usage aggregates every persisted session and rejects malformed IDs", () => {
  const ids = [SessionID.make(`ses_usage_${crypto.randomUUID()}`), SessionID.make(`ses_usage_${crypto.randomUUID()}`)]
  const now = Date.now()
  Database.use((db) => {
    db.insert(ProjectTable)
      .values({
        id: ProjectID.global,
        worktree: "/",
        sandboxes: [],
        time_created: now,
        time_updated: now,
      })
      .onConflictDoNothing()
      .run()
    db.insert(SessionTable)
      .values([
        {
          id: ids[0],
          project_id: ProjectID.global,
          slug: ids[0],
          directory: "usage-a",
          title: "usage-a",
          version: "test",
          cost: 1.25,
          tokens_input: 10,
          tokens_output: 5,
          tokens_reasoning: 2,
          tokens_cache_read: 3,
          tokens_cache_write: 1,
          time_created: now,
          time_updated: now,
        },
        {
          id: ids[1],
          project_id: ProjectID.global,
          slug: ids[1],
          directory: "usage-b",
          title: "usage-b",
          version: "test",
          cost: 0.75,
          tokens_input: 4,
          tokens_output: 1,
          time_created: now,
          time_updated: now,
        },
      ])
      .run()
  })

  const result = Session.usage(ids[0])
  expect(result.session).toEqual({
    tokens: { total: 21, input: 10, output: 5, reasoning: 2, cacheRead: 3, cacheWrite: 1 },
    spend: 1.25,
  })
  expect(result.aggregate.tokens.total).toBeGreaterThanOrEqual(26)
  expect(result.aggregate.spend).toBeGreaterThanOrEqual(2)
  expect(Session.usage("invalid").session).toBeUndefined()

  Database.use((db) => db.delete(SessionTable).where(inArray(SessionTable.id, ids)).run())
})
