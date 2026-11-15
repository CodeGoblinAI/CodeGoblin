import { expect, test } from "bun:test"
import path from "node:path"
import { lastUsedModel, resolveStartupModel } from "../src/core/model-selection"
import { PROVIDERS } from "../src/core/providers"
import { codexAuthStatus } from "../src/core/codex-chat"
import { CodexRpc } from "../src/core/codex-rpc"

test("explicit CLI model startup waits for the real catalog client instead of falling back", async () => {
  const before = PROVIDERS.codex!.models
  PROVIDERS.codex!.models = [{ id: "default", label: "default", contextWindow: 0 }]
  try {
    const selection = await resolveStartupModel("codex/fixture-default", () => codexAuthStatus(() =>
      CodexRpc.start([process.execPath, path.resolve(import.meta.dir, "fixtures/codex-app-server.ts"), "inference"], 3000, true)))
    expect(selection?.provider.id).toBe("codex")
    expect(selection?.model.id).toBe("fixture-default")
    expect(await resolveStartupModel("codex/nonexistent", async () => ({ ready: false, detail: "unavailable" }))).toBeUndefined()
    expect(await resolveStartupModel("deepseek/nonexistent")).toBeUndefined()
    expect((await resolveStartupModel("codex"))?.model.id).toBe("default")
    expect((await resolveStartupModel())?.provider.id).toBe("deepseek")
  } finally {
    PROVIDERS.codex!.models = before
  }
})

test("with no model asked for, the app opens on the one used last", async () => {
  const zai = PROVIDERS.zai!.models[0]!.id
  // The newest that still exists wins; one that is gone is passed over; nothing remembered is the default.
  expect((await lastUsedModel(["zai/" + zai, "deepseek/" + PROVIDERS.deepseek!.models[0]!.id]))).toMatchObject({ provider: { id: "zai" }, model: { id: zai } })
  expect((await lastUsedModel(["zai/a-model-that-was-removed", "nowhere/nothing", "zai/" + zai]))?.model.id).toBe(zai)
  expect((await lastUsedModel([]))?.provider.id).toBe("deepseek")
  expect((await lastUsedModel(["nowhere/nothing"]))?.provider.id).toBe("deepseek")
})
