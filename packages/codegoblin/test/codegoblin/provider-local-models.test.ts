import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { augmentLocalRuntimeModels } from "@/codegoblin/provider"
import { Provider } from "@/provider/provider"
import { ModelID, ProviderID } from "@/provider/schema"

describe("augmentLocalRuntimeModels", () => {
  let dir: string
  const previous = process.env.CODEGOBLIN_MODELS_DIR

  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "cg-aug-"))
    await fs.writeFile(path.join(dir, "gemma-3n-e2b.gguf"), "x")
    await fs.writeFile(path.join(dir, "qwen3-0.6b.gguf"), "y")
    process.env.CODEGOBLIN_MODELS_DIR = dir
  })

  afterAll(async () => {
    if (previous === undefined) delete process.env.CODEGOBLIN_MODELS_DIR
    else process.env.CODEGOBLIN_MODELS_DIR = previous
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
  })

  test("adds installed GGUFs as codegoblin/<id> models to catalog + database", async () => {
    const make = () => ({ codegoblin: { id: "codegoblin", models: {} as Record<string, any> } }) as any
    const catalog = make()
    const database = make()

    await augmentLocalRuntimeModels(catalog, database)

    expect(Object.keys(catalog.codegoblin.models).sort()).toEqual(["gemma-3n-e2b", "qwen3-0.6b"])
    const model = database.codegoblin.models["gemma-3n-e2b"]
    expect(model.providerID).toBe("codegoblin")
    expect(model.api.npm).toBe("@ai-sdk/openai-compatible")
    expect(model.api.url).toContain("/v1")
    expect(model.capabilities.output.text).toBe(true)
  })

  test("never throws when the codegoblin provider entry is absent", async () => {
    const empty: any = {}
    await augmentLocalRuntimeModels(empty, empty)
    expect(empty).toEqual({})
  })
})

describe("ModelNotFoundError message", () => {
  test("explains local runtime setup for codegoblin models", () => {
    const error = new Provider.ModelNotFoundError({
      providerID: ProviderID.make("codegoblin"),
      modelID: ModelID.make("qwen3-0.6b"),
    })
    // pi #6922: a local default with no runtime installed showed nothing but an
    // empty picker. The error now names the commands that fix it.
    expect(error.message).toContain("codegoblin/qwen3-0.6b is not installed")
    expect(error.message).toContain("codegoblin runtime list")
    expect(error.message).toContain("codegoblin runtime pull")
  })

  test("keeps the generic message for cloud providers", () => {
    const error = new Provider.ModelNotFoundError({
      providerID: ProviderID.make("anthropic"),
      modelID: ModelID.make("claude-nope"),
    })
    expect(error.message).toBe("Model anthropic/claude-nope not found.")
  })

  test("includes suggestions when present", () => {
    const error = new Provider.ModelNotFoundError({
      providerID: ProviderID.make("anthropic"),
      modelID: ModelID.make("claude-nope"),
      suggestions: ["claude-opus-5", "claude-sonnet-5"],
    })
    expect(error.message).toContain("Did you mean: claude-opus-5, claude-sonnet-5?")
  })
})
