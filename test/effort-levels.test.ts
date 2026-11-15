import { expect, test } from "bun:test"
import { PROVIDERS, effortFor, effortHint, effortLevels, effortProblem, resolveSelection } from "../src/core/providers"
import { codexAuthStatus } from "../src/core/codex-chat"
import { CodexRpc } from "../src/core/codex-rpc"
import path from "node:path"

const model = (id: string) => resolveSelection(id)!.model

test("each provider's own ladder and default, as its docs give them", () => {
  expect(effortLevels(model("zai/glm-5.3"))).toEqual(["none", "minimal", "low", "medium", "high", "xhigh", "max"])
  expect(model("zai/glm-5.3").defaultEffort).toBe("max")
  expect(effortLevels(model("deepseek/deepseek-v4-pro"))).toEqual(["none", "low", "high", "max"])
  expect(model("deepseek/deepseek-v4-pro").defaultEffort).toBe("high")
  expect(effortLevels(model("claude-code/opus"))).toEqual(["low", "medium", "high", "xhigh", "max"])
  expect(effortLevels(model("claude-code/haiku"))).toEqual([])
  expect(effortLevels(model("openai/gpt-5.6"))).toEqual(["low", "medium", "high"])
  expect(effortLevels(model("meta/muse-spark-1.3"))).toEqual([])
})

test("a level is sent only to a model that has it - never translated to a neighbour", () => {
  expect(effortFor(model("zai/glm-5.3"), "max")).toBe("max")
  expect(effortFor(model("zai/glm-5.3"), "auto")).toBeUndefined()
  expect(effortFor(model("deepseek/deepseek-v4-pro"), "medium")).toBeUndefined()
  expect(effortFor(model("openai/gpt-5.6"), "max")).toBeUndefined()
  expect(effortFor(model("claude-code/haiku"), "high")).toBeUndefined()
  expect(effortProblem(model("deepseek/deepseek-v4-pro"), "DeepSeek V4 Pro", "medium")).toBe('DeepSeek V4 Pro has no "medium" - its levels are none, low, high, max')
  expect(effortProblem(model("claude-code/haiku"), "Claude haiku", "high")).toContain("does not take an effort level")
  expect(effortProblem(model("zai/glm-5.3"), "GLM 5.3", "auto")).toBeUndefined()
})

test("auto says what it means on this model", () => {
  expect(effortHint(model("zai/glm-5.3"), "auto")).toBe("this model's default (max)")
  expect(effortHint(model("deepseek/deepseek-v4-pro"), "auto")).toBe("this model's default (high)")
  expect(effortHint(model("claude-code/opus"), "max")).toBe("the most this model offers: slowest, costs the most")
  expect(effortHint(model("zai/glm-5.3"), "none")).toBe("thinking off: fastest and cheapest")
})

test("Codex keeps every level each model reports, and its default", async () => {
  const fixture = path.resolve(import.meta.dir, "fixtures/codex-app-server.ts")
  const saved = PROVIDERS.codex!.models
  try {
    expect((await codexAuthStatus(() => CodexRpc.start([process.execPath, fixture, "levels"], 3000))).ready).toBe(true)
    const listed = PROVIDERS.codex!.models
    expect(listed.find((entry) => entry.id === "fixture-wide")).toMatchObject({ efforts: ["low", "medium", "high", "xhigh", "max", "ultra"], defaultEffort: "low" })
    // The default alias takes the default model's ladder.
    expect(listed[0]).toMatchObject({ id: "default", efforts: ["low", "medium", "high", "xhigh", "max", "ultra"], defaultEffort: "low" })
    expect(effortFor(listed.find((entry) => entry.id === "fixture-wide")!, "ultra")).toBe("ultra")
  } finally { PROVIDERS.codex!.models = saved }
})
