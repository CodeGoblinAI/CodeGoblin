import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Session } from "@/session/session"
import { Bus } from "@/bus"
import { Storage } from "@/storage/storage"
import { SyncEvent } from "@/sync"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { BackgroundJob } from "@/background/job"
import { CrossSpawnSpawner } from "@codegoblin/core/cross-spawn-spawner"
import { testEffect } from "../lib/effect"
import { ModelID, ProviderID } from "@/provider/schema"

const it = testEffect(
  Layer.mergeAll(
    Session.layer.pipe(
      Layer.provide(Bus.layer),
      Layer.provide(Storage.defaultLayer),
      Layer.provide(SyncEvent.defaultLayer),
      Layer.provide(RuntimeFlags.layer({ experimentalWorkspaces: false })),
      Layer.provide(BackgroundJob.defaultLayer),
    ),
    CrossSpawnSpawner.defaultLayer,
  ),
)

describe("external session import", () => {
  it.instance("stores foreign history as inert text and keeps the selected continuation model", () =>
    Effect.gen(function* () {
      const service = yield* Session.Service
      const imported = yield* service.importExternal({
        source: "codex",
        title: "Codex · Login fix",
        model: { providerID: ProviderID.make("opencode"), id: ModelID.make("deepseek-v4") },
        messages: [
          { role: "assistant", text: "orphaned output is skipped" },
          { role: "user", text: "Fix login", time: 100 },
          { role: "assistant", text: "Done", time: 200 },
        ],
      })
      const messages = yield* service.messages({ sessionID: imported.id })

      expect(imported.title).toBe("Codex · Login fix")
      expect(messages.map((message) => message.info.role)).toEqual(["user", "assistant"])
      expect(messages.map((message) => message.parts.map((part) => (part.type === "text" ? part.text : "")))).toEqual([
        ["Fix login"],
        ["Done"],
      ])
      expect(messages[0].info.role === "user" && messages[0].info.model).toEqual({
        providerID: ProviderID.make("opencode"),
        modelID: ModelID.make("deepseek-v4"),
      })
      expect(messages[1].info.role === "assistant" && messages[1].info.providerID).toBe(ProviderID.make("opencode"))

      yield* service.remove(imported.id)
    }),
  )
})
