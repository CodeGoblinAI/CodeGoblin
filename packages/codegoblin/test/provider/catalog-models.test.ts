import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import * as ModelsDev from "@codegoblin/core/models-dev"

const catalog = await Bun.file(new URL("../../models/api.json", import.meta.url)).json()

describe("model catalog coverage", () => {
  test.each([
    ["anthropic", ["claude-fable-5-2", "claude-haiku-5-5"]],
    ["google", ["gemini-4-hydrogen", "gemini-4-carbon", "gemini-4-argon"]],
    ["openai", ["gpt-6.1-terra"]],
    ["meta", ["muse-ember-1.0", "muse-wonder-1.0"]],
    ["moonshotai", ["kimi-k3.1-pro", "kimi-k3.1-pro-highspeed"]],
    ["minimax", ["MiniMax-M3.1-Flash"]],
    [
      "openrouter",
      [
        "tencent/hy4",
        "thinkingmachines/inkling-2-small",
        "thinkingmachines/inkling-2-small:free",
        "liquid/lfm-3-1.7b",
        "liquid/lfm-3-1.7b:free",
      ],
    ],
    [
      "explabs",
      [
        "gemini-4-carbon",
        "gemini-4-hydrogen",
        "glm-5.3-uncensored",
        "qwen3.8-omni-flash",
        "ling-3.0-tiny",
        "command-a",
        "command-r7b-12-2024",
        "deepseek-v3.2",
        "gpt-chat-latest",
        "kimi-k2.5",
        "deepseek-v4.1-flash-uncensored",
        "glm-5.3-flash-uncensored",
      ],
    ],
  ] satisfies [string, string[]][])("%s includes supported chat and agent models", (provider, ids) => {
    for (const id of ids) {
      const model = Schema.decodeUnknownSync(ModelsDev.Model)(catalog[provider]?.models[id])
      expect(model.id).toBe(id)
      expect(model.tool_call).toBe(true)
      expect(model.modalities?.output).toContain("text")
      expect(model.limit.context).toBeGreaterThan(0)
      expect(model.limit.output).toBeGreaterThan(0)
    }
  })

  test("Gemini Omni retains its generation capabilities without advertising tools", () => {
    const model = Schema.decodeUnknownSync(ModelsDev.Model)(catalog.openrouter.models["google/gemini-omni-1.2-flash"])
    expect(model.tool_call).toBe(false)
    expect(model.modalities?.output).toEqual(["text", "video"])
  })
})
