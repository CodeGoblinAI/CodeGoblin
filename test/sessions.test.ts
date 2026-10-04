import { expect, test } from "bun:test"
import path from "node:path"
import { ago, create, load, save } from "../src/core/sessions"
import { resolveStartupModel } from "../src/core/model-selection"
import { Global } from "../src/platform/paths"
import { requireSandbox } from "./sandbox"

test("ago says how long ago in the sidebar's words", () => {
  const now = 10_000_000_000
  expect(ago(now - 5_000, now)).toBe("just now")
  expect(ago(now - 5 * 60_000, now)).toBe("5m")
  expect(ago(now - 3 * 3_600_000, now)).toBe("3h")
  expect(ago(now - 2 * 86_400_000, now)).toBe("2d")
})

test("session storage retains the last exact model while older sessions remain readable", async () => {
  requireSandbox(path.join(Global.Path.state, "sessions", "check.json"), "session model tests")
  const session = create("deepseek", "deepseek-v4-pro")
  session.messages = [{ role: "user", content: "Remember the model" }]
  await save(session)
  const loaded = await load(session.id)
  expect(loaded?.model).toBe("deepseek-v4-pro")
  expect((await resolveStartupModel(loaded!.provider + "/" + loaded!.model))?.model.id).toBe("deepseek-v4-pro")
  session.provider = "openai"
  session.model = "gpt-5.4"
  await save(session)
  expect(await load(session.id)).toMatchObject({ provider: "openai", model: "gpt-5.4" })
  const legacy = create("deepseek")
  await save(legacy)
  expect((await load(legacy.id))?.model).toBeUndefined()
  expect((await resolveStartupModel(legacy.provider))?.provider.id).toBe("deepseek")
  expect(await resolveStartupModel("deepseek/removed-model")).toBeUndefined()
})
