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
      ["codegoblin", "qwen-image-pro"],
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

  test("routes descriptive prompts through a selected image model", () => {
    expect(
      CodeGoblinImageCommand.shouldRoutePromptToImage({
        prompt: "car with flames",
        providerID: "xai",
        modelID: "grok-imagine-image-quality",
      }),
    ).toBe(true)
  })

  test("does not route casual chat through a selected image model", () => {
    expect(
      CodeGoblinImageCommand.shouldRoutePromptToImage({
        prompt: "hi",
        providerID: "openai",
        modelID: "gpt-image-1",
      }),
    ).toBe(false)
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

  test("normalizes CodeGoblin Qwen aliases to DashScope model IDs", async () => {
    const result = await CodeGoblinImageCommand.generate({
      prompt: "generate an image of a horse",
      provider: "codegoblin",
      model: "qwen-image-pro",
      output: "codegoblin-output/images/test-qwen.png",
      cwd: process.cwd(),
      dryRun: true,
    })

    expect(result.ok).toBe(true)
    expect(result.provider).toBe("qwen")
    expect(result.model).toBe("wan2.7-image-pro")
  })

  test("returns a friendly missing-key error for Qwen image models", async () => {
    const previous = {
      DASHSCOPE_API_KEY: process.env.DASHSCOPE_API_KEY,
      QWEN_API_KEY: process.env.QWEN_API_KEY,
      ALIBABA_API_KEY: process.env.ALIBABA_API_KEY,
      CODEGOBLIN_IMAGE_DISABLE_CONNECTED_AUTH: process.env.CODEGOBLIN_IMAGE_DISABLE_CONNECTED_AUTH,
    }
    delete process.env.DASHSCOPE_API_KEY
    delete process.env.QWEN_API_KEY
    delete process.env.ALIBABA_API_KEY
    process.env.CODEGOBLIN_IMAGE_DISABLE_CONNECTED_AUTH = "1"
    try {
      const result = await CodeGoblinImageCommand.generate({
        prompt: "generate an image of a horse",
        provider: "codegoblin",
        model: "qwen-image-pro",
        output: "codegoblin-output/images/test-qwen.png",
        keyFile: "missing.env",
        cwd: process.cwd(),
      })

      expect(result.ok).toBe(false)
      expect(result.message).toContain("No Qwen/DashScope image key found")
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  })
})
