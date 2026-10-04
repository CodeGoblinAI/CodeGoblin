import { expect, test } from "bun:test"
import { defaults, normalise, withModelEffort, effortForModel, load, save } from "../src/core/settings"
import { Global } from "../src/platform/paths"
import { requireSandbox } from "./sandbox"
requireSandbox(Global.Path.state, "model effort")

test("effort follows the exact provider/model, including auto", () => {
  const first = withModelEffort(defaults(), "zai/glm-5.3", "high")
  const next = withModelEffort(first, "codex/gpt-5.6-luna", "low")
  expect(effortForModel(next, "zai/glm-5.3")).toBe("high")
  expect(effortForModel(next, "codex/gpt-5.6-luna")).toBe("low")
  expect(effortForModel(next, "other/glm-5.3")).toBe("auto")
  expect(effortForModel(withModelEffort(next, "zai/glm-5.3", "auto"), "zai/glm-5.3")).toBe("auto")
})
test("legacy global preference survives until first scoped choice", () => {
  const legacy = normalise({effort:"medium"})
  expect(effortForModel(legacy,"a/b")).toBe("medium")
  const next = withModelEffort(legacy,"a/b","high")
  expect(effortForModel(next,"a/c")).toBe("auto")
})
test("untrusted maps drop malformed keys and levels", () => {
  expect(normalise({effortByModel:{"x/y":"high","bad":"low","x/z":"max"}}).effortByModel).toEqual({"x/y":"high"})
  expect(normalise({effortByModel:["high"]}).effortByModel).toEqual({})
  expect(()=>withModelEffort(defaults(), "", "high")).toThrow()
  expect(()=>withModelEffort(defaults(), "a/b", "max")).toThrow()
})
test("scoped effort survives settings save/load", async () => {
  const original = await load()
  try {
    await save(withModelEffort(defaults(),"codex/gpt-5.6-luna","high"))
    expect(effortForModel(await load(),"codex/gpt-5.6-luna")).toBe("high")
    expect(effortForModel(await load(),"claude-code/haiku")).toBe("auto")
  } finally { await save(original) }
})
