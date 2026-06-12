import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { augmentLocalRuntimeModels } from "@/codegoblin/provider"

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
