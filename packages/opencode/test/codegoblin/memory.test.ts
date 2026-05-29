import { afterEach, expect, test } from "bun:test"
import { Database } from "@/storage/db"
import { CodeGoblinMemory } from "../../src/codegoblin/memory"
import { MemoryEntryTable } from "../../src/codegoblin/memory.sql"

function truncate() {
  Database.use((db) => db.delete(MemoryEntryTable).run())
}

function insert(input: {
  id: string
  scope: string
  content: string
  pinned?: boolean
  archived?: boolean
  projectID?: string
}) {
  Database.use((db) =>
    db
      .insert(MemoryEntryTable)
      .values({
        id: input.id,
        scope: input.scope,
        content: input.content,
        pinned: input.pinned ?? false,
        project_id: input.projectID ?? null,
        time_archived: input.archived ? Date.now() : null,
      })
      .run(),
  )
}

afterEach(() => truncate())

test("list returns empty when no memory exists", () => {
  expect(CodeGoblinMemory.list()).toEqual([])
})

test("status counts entries by scope and state", () => {
  insert({ id: CodeGoblinMemory.generateID(), scope: "user", content: "likes short captions", pinned: true })
  insert({ id: CodeGoblinMemory.generateID(), scope: "project", content: "default branch is dev", projectID: "p1" })
  insert({ id: CodeGoblinMemory.generateID(), scope: "session", content: "scratch note", archived: true })

  const status = CodeGoblinMemory.status()
  expect(status.total).toBe(3)
  expect(status.active).toBe(2)
  expect(status.archived).toBe(1)
  expect(status.pinned).toBe(1)
  expect(status.byScope).toEqual({ user: 1, project: 1, session: 1 })
})

test("list hides archived entries unless includeArchived is set", () => {
  insert({ id: CodeGoblinMemory.generateID(), scope: "user", content: "active note" })
  insert({ id: CodeGoblinMemory.generateID(), scope: "user", content: "old note", archived: true })

  expect(CodeGoblinMemory.list().map((entry) => entry.content)).toEqual(["active note"])
  expect(CodeGoblinMemory.list({ includeArchived: true }).length).toBe(2)
})

test("list filters by scope and project", () => {
  insert({ id: CodeGoblinMemory.generateID(), scope: "user", content: "user note" })
  insert({ id: CodeGoblinMemory.generateID(), scope: "project", content: "project a", projectID: "a" })
  insert({ id: CodeGoblinMemory.generateID(), scope: "project", content: "project b", projectID: "b" })

  expect(CodeGoblinMemory.list({ scope: "user" }).map((entry) => entry.content)).toEqual(["user note"])
  expect(CodeGoblinMemory.list({ scope: "project", projectID: "b" }).map((entry) => entry.content)).toEqual([
    "project b",
  ])
})
