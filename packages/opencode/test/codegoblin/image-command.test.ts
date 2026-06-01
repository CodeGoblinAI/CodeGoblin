import { describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "fs/promises"
import os from "os"
import path from "path"
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

  test("parses explicit and last-image edit inputs", () => {
    const parsed = CodeGoblinImageCommand.parse('make it red --image codegoblin-output/images/base.png --last-image')
    expect(parsed.inputImages).toEqual([{ path: "codegoblin-output/images/base.png" }])
    expect(parsed.useLastImage).toBe(true)
  })

  test("sends explicit input images to Gemini for edits", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codegoblin-image-edit-"))
    const previous = withGeminiEnv()
    const originalFetch = globalThis.fetch
    try {
      await writeFile(path.join(root, "base.png"), Buffer.from([1, 2, 3, 4]))
      globalThis.fetch = (async (_input, init) => {
        const body = JSON.parse(String(init?.body ?? "{}"))
        expect(body.contents[0].parts[1].inline_data).toEqual({
          mime_type: "image/png",
          data: Buffer.from([1, 2, 3, 4]).toString("base64"),
        })
        return Response.json({
          candidates: [{ content: { parts: [{ inlineData: { data: Buffer.from([5, 6]).toString("base64") } }] } }],
        })
      }) as typeof fetch
      const result = await CodeGoblinImageCommand.generate({
        prompt: "make it green",
        provider: "google",
        model: "gemini-2.5-flash-image",
        cwd: root,
        output: "out.png",
        inputImages: [{ path: "base.png" }],
      })
      expect(result.ok).toBe(true)
      expect(await readFile(path.join(root, "out.png"))).toEqual(Buffer.from([5, 6]))
    } finally {
      restoreEnv(previous)
      globalThis.fetch = originalFetch
      await rm(root, { recursive: true, force: true })
    }
  })

  test("uses the last generated image for edit-style prompts", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codegoblin-image-last-"))
    const previous = withGeminiEnv()
    const originalFetch = globalThis.fetch
    try {
      await mkdir(path.join(root, "codegoblin-output", "images"), { recursive: true })
      await writeFile(path.join(root, "codegoblin-output", "images", "base.png"), Buffer.from([9, 8, 7]))
      await writeFile(
        path.join(root, "codegoblin-output", "usage.json"),
        JSON.stringify({ last: { output: "codegoblin-output/images/base.png" } }),
      )
      globalThis.fetch = (async (_input, init) => {
        const body = JSON.parse(String(init?.body ?? "{}"))
        expect(body.contents[0].parts[1].inline_data.data).toBe(Buffer.from([9, 8, 7]).toString("base64"))
        return Response.json({
          candidates: [{ content: { parts: [{ inlineData: { data: Buffer.from([1]).toString("base64") } }] } }],
        })
      }) as typeof fetch
      const result = await CodeGoblinImageCommand.generate({
        prompt: "make him red",
        provider: "google",
        model: "gemini-2.5-flash-image",
        cwd: root,
        output: "edited.png",
      })
      expect(result.ok).toBe(true)
    } finally {
      restoreEnv(previous)
      globalThis.fetch = originalFetch
      await rm(root, { recursive: true, force: true })
    }
  })

  test("fails clearly when an edit asks for the last image but none exists", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codegoblin-image-no-last-"))
    try {
      const result = await CodeGoblinImageCommand.generate({
        prompt: "make it red",
        provider: "google",
        model: "gemini-2.5-flash-image",
        cwd: root,
        dryRun: true,
      })
      expect(result.ok).toBe(false)
      expect(result.message).toContain("No previous CodeGoblin image")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("returns actionable Gemini network errors", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codegoblin-image-network-"))
    const previous = withGeminiEnv()
    const originalFetch = globalThis.fetch
    try {
      globalThis.fetch = (async () => {
        throw new TypeError("Unable to connect. Is the computer able to access the url?")
      }) as unknown as typeof fetch
      const result = await CodeGoblinImageCommand.generate({
        prompt: "generate an image of a horse",
        provider: "google",
        model: "gemini-2.5-flash-image",
        cwd: root,
        output: "horse.png",
      })
      expect(result.ok).toBe(false)
      expect(result.message).toContain("could not connect to https://generativelanguage.googleapis.com")
      expect(result.message).toContain("Unable to connect")
    } finally {
      restoreEnv(previous)
      globalThis.fetch = originalFetch
      await rm(root, { recursive: true, force: true })
    }
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

function withGeminiEnv() {
  const previous = {
    GEMINI_API_KEY: process.env.GEMINI_API_KEY,
    GOOGLE_API_KEY: process.env.GOOGLE_API_KEY,
    GOOGLE_GENERATIVE_AI_API_KEY: process.env.GOOGLE_GENERATIVE_AI_API_KEY,
    CODEGOBLIN_IMAGE_DISABLE_CONNECTED_AUTH: process.env.CODEGOBLIN_IMAGE_DISABLE_CONNECTED_AUTH,
  }
  process.env.GEMINI_API_KEY = "test-gemini-key"
  delete process.env.GOOGLE_API_KEY
  delete process.env.GOOGLE_GENERATIVE_AI_API_KEY
  process.env.CODEGOBLIN_IMAGE_DISABLE_CONNECTED_AUTH = "1"
  return previous
}

function restoreEnv(previous: Record<string, string | undefined>) {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}
