import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  catalogEntry,
  detectAccel,
  listInstalledModels,
  modelPath,
  runtimeDir,
  selectEngineAssets,
  LOCAL_MODEL_CATALOG,
} from "@/codegoblin/local-runtime"

// Real llama.cpp b9536 Windows asset names.
const WIN_ASSETS = [
  "cudart-llama-bin-win-cuda-12.4-x64.zip",
  "cudart-llama-bin-win-cuda-13.3-x64.zip",
  "llama-b9536-bin-win-cuda-12.4-x64.zip",
  "llama-b9536-bin-win-cuda-13.3-x64.zip",
  "llama-b9536-bin-win-cpu-x64.zip",
]

describe("selectEngineAssets", () => {
  test("Windows CUDA picks the lowest CUDA engine + matching cudart", () => {
    const { engine, cudart } = selectEngineAssets(WIN_ASSETS, "win32", "cuda")
    expect(engine).toBe("llama-b9536-bin-win-cuda-12.4-x64.zip")
    expect(cudart).toBe("cudart-llama-bin-win-cuda-12.4-x64.zip")
  })

  test("Windows CPU picks the cpu engine and no cudart", () => {
    const { engine, cudart } = selectEngineAssets(WIN_ASSETS, "win32", "cpu")
    expect(engine).toBe("llama-b9536-bin-win-cpu-x64.zip")
    expect(cudart).toBeUndefined()
  })

  test("Linux picks an ubuntu engine", () => {
    const assets = ["llama-b9536-bin-ubuntu-x64.zip", "llama-b9536-bin-ubuntu-vulkan-x64.zip"]
    expect(selectEngineAssets(assets, "linux", "cpu").engine).toBe("llama-b9536-bin-ubuntu-x64.zip")
  })
})

describe("detectAccel", () => {
  test("uses CUDA when an NVIDIA GPU is present, CPU otherwise", () => {
    expect(detectAccel(true, {})).toBe("cuda")
    expect(detectAccel(false, {})).toBe("cpu")
  })

  test("respects CODEGOBLIN_RUNTIME_ACCEL override", () => {
    expect(detectAccel(true, { CODEGOBLIN_RUNTIME_ACCEL: "cpu" })).toBe("cpu")
    expect(detectAccel(false, { CODEGOBLIN_RUNTIME_ACCEL: "cuda" })).toBe("cuda")
  })
})

describe("paths + catalog", () => {
  test("runtimeDir honors CODEGOBLIN_RUNTIME_DIR", () => {
    expect(runtimeDir({ CODEGOBLIN_RUNTIME_DIR: "C:/rt" })).toBe(path.resolve("C:/rt"))
  })

  test("modelPath appends .gguf when missing", () => {
    const base = path.resolve("/m")
    expect(modelPath("gemma-3n-e2b", { CODEGOBLIN_MODELS_DIR: "/m" })).toBe(path.join(base, "gemma-3n-e2b.gguf"))
    expect(modelPath("x.gguf", { CODEGOBLIN_MODELS_DIR: "/m" })).toBe(path.join(base, "x.gguf"))
  })

  test("catalog is non-empty and lookup is case-insensitive", () => {
    expect(LOCAL_MODEL_CATALOG.length).toBeGreaterThan(0)
    expect(catalogEntry("GEMMA-3N-E2B")?.id).toBe("gemma-3n-e2b")
    expect(catalogEntry("nope")).toBeUndefined()
    for (const entry of LOCAL_MODEL_CATALOG) {
      expect(entry.url).toMatch(/^https:\/\/huggingface\.co\/.*\.gguf$/)
    }
  })
})

describe("listInstalledModels", () => {
  let dir: string
  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "cg-models-"))
    await fs.writeFile(path.join(dir, "gemma-3n-e2b.gguf"), "x")
    await fs.writeFile(path.join(dir, "qwen3-0.6b.gguf"), "xy")
    await fs.writeFile(path.join(dir, "notes.txt"), "ignore me")
  })
  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
  })

  test("lists only .gguf files, id without extension, sorted", async () => {
    const models = await listInstalledModels({ CODEGOBLIN_MODELS_DIR: dir })
    expect(models.map((m) => m.id)).toEqual(["gemma-3n-e2b", "qwen3-0.6b"])
    expect(models[0]?.sizeBytes).toBeGreaterThan(0)
  })

  test("returns empty for a missing dir", async () => {
    expect(await listInstalledModels({ CODEGOBLIN_MODELS_DIR: path.join(dir, "nope") })).toEqual([])
  })
})
