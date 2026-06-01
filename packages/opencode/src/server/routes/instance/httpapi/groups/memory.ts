import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { WorkspaceRoutingQuery, WorkspaceRoutingQueryFields } from "../middleware/workspace-routing"
import { described } from "./metadata"

export const MemoryScope = Schema.Literals(["user", "project", "session"])

export const MemoryEntry = Schema.Struct({
  id: Schema.String,
  scope: MemoryScope,
  projectID: Schema.optional(Schema.String),
  sourceSessionID: Schema.optional(Schema.String),
  content: Schema.String,
  tags: Schema.Array(Schema.String),
  pinned: Schema.Boolean,
  archived: Schema.Boolean,
  timeCreated: Schema.Number,
  timeUpdated: Schema.Number,
}).annotate({ identifier: "CodeGoblinMemoryEntry" })

export const MemoryStatus = Schema.Struct({
  total: Schema.Number,
  active: Schema.Number,
  archived: Schema.Number,
  pinned: Schema.Number,
  byScope: Schema.Record(Schema.String, Schema.Number),
}).annotate({ identifier: "CodeGoblinMemoryStatus" })

export const MemoryListQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  scope: Schema.optional(MemoryScope),
  projectID: Schema.optional(Schema.String),
  query: Schema.optional(Schema.String),
  includeArchived: Schema.optional(Schema.String),
  limit: Schema.optional(Schema.String),
})

export const MemoryAddPayload = Schema.Struct({
  scope: MemoryScope,
  content: Schema.String,
  projectID: Schema.optional(Schema.String),
  sourceSessionID: Schema.optional(Schema.String),
  tags: Schema.optional(Schema.Array(Schema.String)),
  pinned: Schema.optional(Schema.Boolean),
})

export const MemoryPinPayload = Schema.Struct({
  pinned: Schema.Boolean,
})

export const MemoryMutationResponse = Schema.Struct({
  success: Schema.Boolean,
})

export class MemoryRejectedError extends Schema.ErrorClass<MemoryRejectedError>("CodeGoblinMemoryRejectedError")(
  { error: Schema.String },
  { httpApiStatus: 400 },
) {}

export const MemoryPaths = {
  list: "/codegoblin/memory",
  status: "/codegoblin/memory/status",
  pin: "/codegoblin/memory/:id/pin",
  restore: "/codegoblin/memory/:id/restore",
  entry: "/codegoblin/memory/:id",
} as const

export const MemoryApi = HttpApi.make("codegoblin-memory").add(
  HttpApiGroup.make("memory")
    .add(
      HttpApiEndpoint.get("list", MemoryPaths.list, {
        query: MemoryListQuery,
        success: described(Schema.Array(MemoryEntry), "Stored memory entries"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "memory.list",
          summary: "List memory",
          description: "List or search CodeGoblin memory entries.",
        }),
      ),
      HttpApiEndpoint.get("status", MemoryPaths.status, {
        query: WorkspaceRoutingQuery,
        success: described(MemoryStatus, "Memory store status"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "memory.status",
          summary: "Memory status",
          description: "Counts of total, active, archived, and pinned memory entries.",
        }),
      ),
      HttpApiEndpoint.post("add", MemoryPaths.list, {
        query: WorkspaceRoutingQuery,
        payload: MemoryAddPayload,
        success: described(MemoryEntry, "Memory entry added"),
        error: MemoryRejectedError,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "memory.add",
          summary: "Add memory",
          description: "Add a CodeGoblin memory entry. Content is scanned by the security guard before storage.",
        }),
      ),
      HttpApiEndpoint.post("pin", MemoryPaths.pin, {
        params: { id: Schema.String },
        query: WorkspaceRoutingQuery,
        payload: MemoryPinPayload,
        success: described(MemoryMutationResponse, "Pin state updated"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "memory.pin",
          summary: "Pin memory",
          description: "Pin or unpin a memory entry.",
        }),
      ),
      HttpApiEndpoint.post("restore", MemoryPaths.restore, {
        params: { id: Schema.String },
        query: WorkspaceRoutingQuery,
        success: described(MemoryMutationResponse, "Memory entry restored"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "memory.restore",
          summary: "Restore memory",
          description: "Restore an archived memory entry.",
        }),
      ),
      HttpApiEndpoint.delete("remove", MemoryPaths.entry, {
        params: { id: Schema.String },
        query: WorkspaceRoutingQuery,
        success: described(MemoryMutationResponse, "Memory entry archived"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "memory.remove",
          summary: "Archive memory",
          description: "Archive (soft-delete) a memory entry.",
        }),
      ),
  ),
)
