import { Effect, Option } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { MemoryAddPayload, MemoryPinPayload, MemoryRejectedError } from "../groups/memory"
import { CodeGoblinMemory, CodeGoblinMemoryError, type CodeGoblinMemoryScope } from "@/codegoblin/memory"
import { Project } from "@/project/project"

export const memoryHandlers = HttpApiBuilder.group(InstanceHttpApi, "memory", (handlers) =>
  Effect.gen(function* () {
    const project = yield* Project.Service

    const list = Effect.fn("MemoryHttpApi.list")(function* (ctx: {
      query: {
        scope?: CodeGoblinMemoryScope
        projectID?: string
        query?: string
        includeArchived?: string
        limit?: string
      }
    }) {
      const input = {
        scope: ctx.query.scope,
        projectID: ctx.query.projectID,
        includeArchived: ctx.query.includeArchived === "true",
        limit: ctx.query.limit ? Number(ctx.query.limit) : undefined,
      }
      const entries = ctx.query.query ? CodeGoblinMemory.search(ctx.query.query, input) : CodeGoblinMemory.list(input)
      return entries
    })

    const status = Effect.fn("MemoryHttpApi.status")(function* () {
      return CodeGoblinMemory.status()
    })

    const add = Effect.fn("MemoryHttpApi.add")(function* (ctx: {
      query: {
        directory?: string
      }
      payload: typeof MemoryAddPayload.Type
    }) {
      const resolvedProjectID =
        ctx.payload.scope !== "project" || ctx.payload.projectID
          ? Option.none<string>()
          : yield* Effect.option(
              project.fromDirectory(ctx.query.directory || process.cwd()).pipe(Effect.map((result) => result.project.id)),
            )
      const projectID =
        ctx.payload.scope === "project"
          ? (ctx.payload.projectID ?? (Option.isSome(resolvedProjectID) ? resolvedProjectID.value : undefined))
          : ctx.payload.projectID
      return yield* Effect.try({
        try: () =>
          CodeGoblinMemory.add({
            scope: ctx.payload.scope,
            content: ctx.payload.content,
            projectID,
            sourceSessionID: ctx.payload.sourceSessionID,
            tags: ctx.payload.tags ? [...ctx.payload.tags] : undefined,
            pinned: ctx.payload.pinned,
          }),
        catch: (error) =>
          new MemoryRejectedError({
            error: error instanceof CodeGoblinMemoryError ? error.message : String(error),
          }),
      })
    })

    const pin = Effect.fn("MemoryHttpApi.pin")(function* (ctx: {
      params: { id: string }
      payload: typeof MemoryPinPayload.Type
    }) {
      return { success: CodeGoblinMemory.setPinned(ctx.params.id, ctx.payload.pinned) }
    })

    const restore = Effect.fn("MemoryHttpApi.restore")(function* (ctx: { params: { id: string } }) {
      return { success: CodeGoblinMemory.restore(ctx.params.id) }
    })

    const remove = Effect.fn("MemoryHttpApi.remove")(function* (ctx: { params: { id: string } }) {
      return { success: CodeGoblinMemory.remove(ctx.params.id) }
    })

    return handlers
      .handle("list", list)
      .handle("status", status)
      .handle("add", add)
      .handle("pin", pin)
      .handle("restore", restore)
      .handle("remove", remove)
  }),
)
