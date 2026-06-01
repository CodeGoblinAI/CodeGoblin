import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { InstanceState } from "@/effect/instance-state"
import {
  CodeGoblinMemory,
  CodeGoblinMemoryError,
  type CodeGoblinMemoryEntry,
  type CodeGoblinMemoryScope,
} from "@/codegoblin/memory"

const DESCRIPTION = [
  "Persist and recall durable memory across sessions for CodeGoblin.",
  "",
  "Use this when the user shares a durable preference, fact, decision, or",
  "project convention worth remembering for later sessions — or when you want",
  "to recall what you already know.",
  "",
  "Actions:",
  "- add: store a new memory. Choose a scope:",
  "    user    = global preferences/facts that apply everywhere",
  "    project = facts specific to the current project/repo",
  "    session = ephemeral notes scoped to the current session",
  "- list: list active memories (optionally filtered by scope).",
  "- search: substring search across memories for a query.",
  "- remove: archive a memory by its id.",
  "",
  "Keep each memory a single concise fact. Do NOT store secrets or credentials.",
].join("\n")

export const Parameters = Schema.Struct({
  action: Schema.Literals(["add", "list", "search", "remove"]).annotate({
    description: "The memory operation to perform.",
  }),
  scope: Schema.optional(Schema.Literals(["user", "project", "session"])).annotate({
    description: "Scope for add/list. Defaults to 'project' for add, all scopes for list.",
  }),
  content: Schema.optional(Schema.String).annotate({
    description: "The fact to remember. Required for action 'add'.",
  }),
  query: Schema.optional(Schema.String).annotate({
    description: "Search query. Required for action 'search'.",
  }),
  id: Schema.optional(Schema.String).annotate({
    description: "Memory id. Required for action 'remove'.",
  }),
  tags: Schema.optional(Schema.mutable(Schema.Array(Schema.String))).annotate({
    description: "Optional tags to attach when adding a memory.",
  }),
  pinned: Schema.optional(Schema.Boolean).annotate({
    description: "Pin the memory so it is always surfaced first. Use sparingly.",
  }),
})

type Metadata = {
  action: string
  count?: number
}

function formatEntry(entry: CodeGoblinMemoryEntry): string {
  const tags = entry.tags.length ? ` [${entry.tags.join(", ")}]` : ""
  const pin = entry.pinned ? " [pinned]" : ""
  return `${entry.id} (${entry.scope})${pin}: ${entry.content}${tags}`
}

export const MemoryTool = Tool.define<typeof Parameters, Metadata, never>(
  "memory",
  Effect.gen(function* () {
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, _ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const projectID = instance.project.id

          switch (params.action) {
            case "add": {
              if (!params.content?.trim())
                return { title: "memory add", output: "Error: 'content' is required for add.", metadata: { action: "add" } }
              const scope: CodeGoblinMemoryScope = params.scope ?? "project"
              try {
                const entry = CodeGoblinMemory.add({
                  scope,
                  content: params.content,
                  projectID: scope === "project" ? projectID : undefined,
                  sourceSessionID: scope === "session" ? _ctx.sessionID : undefined,
                  tags: params.tags,
                  pinned: params.pinned,
                })
                return {
                  title: `Remembered (${scope})`,
                  output: `Stored memory ${entry.id}:\n${formatEntry(entry)}`,
                  metadata: { action: "add" },
                }
              } catch (error) {
                const message = error instanceof CodeGoblinMemoryError ? error.message : String(error)
                return { title: "memory add", output: `Error: ${message}`, metadata: { action: "add" } }
              }
            }
            case "search": {
              if (!params.query?.trim())
                return {
                  title: "memory search",
                  output: "Error: 'query' is required for search.",
                  metadata: { action: "search" },
                }
              const results = CodeGoblinMemory.search(params.query, {
                scope: params.scope,
                projectID: params.scope === "project" ? projectID : undefined,
                limit: 25,
              })
              return {
                title: `${results.length} matches`,
                output: results.length ? results.map(formatEntry).join("\n") : "No matching memories.",
                metadata: { action: "search", count: results.length },
              }
            }
            case "remove": {
              if (!params.id?.trim())
                return { title: "memory remove", output: "Error: 'id' is required for remove.", metadata: { action: "remove" } }
              const removed = CodeGoblinMemory.remove(params.id)
              return {
                title: removed ? "Removed memory" : "Not found",
                output: removed ? `Archived memory ${params.id}.` : `No memory found with id ${params.id}.`,
                metadata: { action: "remove" },
              }
            }
            case "list":
            default: {
              const results = CodeGoblinMemory.list({
                scope: params.scope,
                projectID: params.scope === "project" ? projectID : undefined,
                limit: 50,
              })
              return {
                title: `${results.length} memories`,
                output: results.length ? results.map(formatEntry).join("\n") : "No memories stored yet.",
                metadata: { action: "list", count: results.length },
              }
            }
          }
        }),
    } satisfies Tool.DefWithoutID<typeof Parameters, Metadata>
  }),
)
