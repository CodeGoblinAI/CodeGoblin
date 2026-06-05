import { describe, expect, test } from "bun:test"
import { CodeGoblin3DCommand } from "@/codegoblin/model3d-command"
import { estimateTripoCredits } from "@/codegoblin/model3d-providers/tripo"

describe("CodeGoblin 3D command model routing", () => {
  test("does not route 3D prompts through non-3D models", () => {
    expect(
      CodeGoblin3DCommand.shouldRoutePromptTo3D("generate a wooden chair", "deepseek", "deepseek-v4-flash"),
    ).toBe(false)
  })

  test("routes 3D prompts when a Tripo model is selected", () => {
    expect(
      CodeGoblin3DCommand.shouldRoutePromptTo3D("generate a wooden chair", "tripo", "text-to-model"),
    ).toBe(true)
  })

  test("does not route casual chat through a selected 3D model", () => {
    expect(CodeGoblin3DCommand.shouldRoutePromptTo3D("hi", "tripo", "text-to-model")).toBe(false)
  })

  test("detects image input mode when attachments are present", () => {
    expect(
      CodeGoblin3DCommand.detectInputMode({
        prompt: "turn this into 3d",
        provider: "tripo",
        model: "image-to-model",
        inputImages: [{ path: "photo.jpg" }],
      }),
    ).toBe("image")
  })

  test("dry-runs Tripo text-to-model with normalized defaults", async () => {
    const result = await CodeGoblin3DCommand.generate({
      prompt: "wooden chair",
      provider: "tripo",
      model: "text-to-model",
      modelVersion: "v3.1-20260211",
      output: "codegoblin-output/models/chair.glb",
      cwd: process.cwd(),
      dryRun: true,
    })

    expect(result.ok).toBe(true)
    expect(result.provider).toBe("tripo")
    expect(result.model).toBe("text-to-model")
    expect(result.inputMode).toBe("text")
    expect(result.message).toContain("tripo/text-to-model")
  })

  test("rejects explicit non-3D provider selection instead of defaulting", async () => {
    const result = await CodeGoblin3DCommand.generate({
      prompt: "wooden chair",
      provider: "deepseek",
      model: "deepseek-v4-flash",
      cwd: process.cwd(),
      dryRun: true,
      require3DModel: true,
    })

    expect(result.ok).toBe(false)
    expect(result.requires3DModel).toBe(true)
  })

  test("does not fall through to Tripo when HTTP-style require3DModel rejects the model", async () => {
    const previous = process.env.TRIPO_API_KEY
    delete process.env.TRIPO_API_KEY
    process.env.CODEGOBLIN_MODEL3D_DISABLE_CONNECTED_AUTH = "1"
    try {
      const result = await CodeGoblin3DCommand.generate({
        prompt: "wooden chair",
        provider: "deepseek",
        model: "deepseek-v4-flash",
        cwd: process.cwd(),
        require3DModel: true,
      })
      expect(result.ok).toBe(false)
      expect(result.requires3DModel).toBe(true)
      expect(result.message).not.toContain("TRIPO_API_KEY")
    } finally {
      if (previous) process.env.TRIPO_API_KEY = previous
      else delete process.env.TRIPO_API_KEY
      delete process.env.CODEGOBLIN_MODEL3D_DISABLE_CONNECTED_AUTH
    }
  })

  test("reports missing Tripo key without sending a request", async () => {
    const previous = process.env.TRIPO_API_KEY
    const previousDisable = process.env.CODEGOBLIN_MODEL3D_DISABLE_CONNECTED_AUTH
    delete process.env.TRIPO_API_KEY
    process.env.CODEGOBLIN_MODEL3D_DISABLE_CONNECTED_AUTH = "1"
    try {
      const result = await CodeGoblin3DCommand.generate({
        prompt: "wooden chair",
        provider: "tripo",
        model: "text-to-model",
        cwd: process.cwd(),
      })

      expect(result.ok).toBe(false)
      expect(result.message).toContain("TRIPO_API_KEY")
    } finally {
      if (previous) process.env.TRIPO_API_KEY = previous
      else delete process.env.TRIPO_API_KEY
      if (previousDisable) process.env.CODEGOBLIN_MODEL3D_DISABLE_CONNECTED_AUTH = previousDisable
      else delete process.env.CODEGOBLIN_MODEL3D_DISABLE_CONNECTED_AUTH
    }
  })

  test("estimates Tripo credits by input mode", () => {
    expect(CodeGoblin3DCommand.estimateCredits("tripo", "text", "v3.0-20250812")).toBe(20)
    expect(CodeGoblin3DCommand.estimateCredits("tripo", "image", "v3.0-20250812")).toBe(30)
    expect(estimateTripoCredits("text", "v3.1-20260211")).toBe(20)
  })
})
