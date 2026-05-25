import { describe, expect, test } from "bun:test"
import { CodeGoblinImageCommand } from "@/codegoblin/image-command"

describe("CodeGoblin image command model routing", () => {
  test("does not route image prompts through non-image models", () => {
    expect(
      CodeGoblinImageCommand.shouldRoutePromptToImage({
        prompt: "generate an image of a horse",
        providerID: "deepseek",
        modelID: "deepseek-v4-flash",
      }),
    ).toBe(false)
  })

  test("routes image prompts only when an image model is selected", () => {
    for (const [providerID, modelID] of [
      ["google", "gemini-2.5-flash-image"],
      ["xai", "grok-imagine-image-quality"],
      ["openai", "gpt-image-1"],
      ["alibaba", "wan2.7-image-pro"],
      ["qwen", "wan2.7-image-edit"],
    ]) {
      expect(
        CodeGoblinImageCommand.shouldRoutePromptToImage({
          prompt: "generate an image of a horse",
          providerID,
          modelID,
        }),
      ).toBe(true)
    }
  })

  test("rejects explicit non-image provider selection instead of defaulting", async () => {
    const result = await CodeGoblinImageCommand.generate({
      prompt: "generate an image of a horse",
      provider: "deepseek",
      model: "deepseek-v4-flash",
      cwd: process.cwd(),
      dryRun: true,
    })

    expect(result.ok).toBe(false)
    expect(result.requiresImageModel).toBe(true)
  })

  test("dry-runs supported image providers with normalized defaults", async () => {
    const result = await CodeGoblinImageCommand.generate({
      prompt: "generate an image of a horse",
      provider: "openai",
      model: "gpt-image-1",
      output: "codegoblin-output/images/test-openai.png",
      cwd: process.cwd(),
      dryRun: true,
    })

    expect(result.ok).toBe(true)
    expect(result.provider).toBe("openai")
    expect(result.model).toBe("gpt-image-1")
    expect(result.message).toContain("openai/gpt-image-1")
  })
})
