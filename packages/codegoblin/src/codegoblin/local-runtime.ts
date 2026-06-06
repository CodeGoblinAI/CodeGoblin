import fs from "fs/promises"
import path from "path"
import { Global } from "@codegoblin/core/global"

/**
 * First-party local runtime: CodeGoblin ships/manages a prebuilt llama.cpp engine
 * (`codegoblin-native llama` supervises `llama-server`) and a set of local GGUF models.
 *
 * Layout under the runtime dir (default `<data>/runtime`, override `CODEGOBLIN_RUNTIME_DIR`):
 *   engine/llama-server(.exe) + ggml/cudart DLLs
 *   models/<id>.gguf
 *   runtime.json   { model, port }
 */

export type LocalRuntimeAccel = "cuda" | "cpu"

export type LocalModelCatalogEntry = {
  id: string
  name: string
  family: string
  /** Non-gated GGUF download URL. */
  url: string
  approxMB: number
  context: number
}

/** Built-in pull catalog — small, non-gated GGUF models verified to run on the bundled engine. */
export const LOCAL_MODEL_CATALOG: LocalModelCatalogEntry[] = [
  {
    id: "gemma-3n-e2b",
    name: "Gemma 3n E2B (Q4_K_M)",
    family: "gemma",
    url: "https://huggingface.co/unsloth/gemma-3n-E2B-it-GGUF/resolve/main/gemma-3n-E2B-it-Q4_K_M.gguf",
    approxMB: 2900,
    context: 32768,
  },
  {
    id: "qwen3-0.6b",
    name: "Qwen3 0.6B (Q4_K_M)",
    family: "qwen",
    url: "https://huggingface.co/unsloth/Qwen3-0.6B-GGUF/resolve/main/Qwen3-0.6B-Q4_K_M.gguf",
    approxMB: 380,
    context: 32768,
  },
  {
    id: "qwen3-1.7b",
    name: "Qwen3 1.7B (Q4_K_M)",
    family: "qwen",
    url: "https://huggingface.co/unsloth/Qwen3-1.7B-GGUF/resolve/main/Qwen3-1.7B-Q4_K_M.gguf",
    approxMB: 1100,
    context: 32768,
  },
  {
    id: "qwen2.5-0.5b",
    name: "Qwen2.5 0.5B Instruct (Q4_K_M)",
    family: "qwen",
    url: "https://huggingface.co/bartowski/Qwen2.5-0.5B-Instruct-GGUF/resolve/main/Qwen2.5-0.5B-Instruct-Q4_K_M.gguf",
    approxMB: 400,
    context: 32768,
  },
]

export function runtimeDir(env: Record<string, string | undefined> = process.env): string {
  const override = env.CODEGOBLIN_RUNTIME_DIR?.trim()
  return override ? path.resolve(override) : path.join(Global.Path.data, "runtime")
}

export function engineDir(env?: Record<string, string | undefined>): string {
  return path.join(runtimeDir(env), "engine")
}

export function modelsDir(env: Record<string, string | undefined> = process.env): string {
  const override = env.CODEGOBLIN_MODELS_DIR?.trim()
  return override ? path.resolve(override) : path.join(runtimeDir(env), "models")
}

export function engineBinaryName(platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? "llama-server.exe" : "llama-server"
}

export function enginePath(env?: Record<string, string | undefined>, platform?: NodeJS.Platform): string {
  return path.join(engineDir(env), engineBinaryName(platform))
}

export function modelPath(id: string, env?: Record<string, string | undefined>): string {
  const file = id.endsWith(".gguf") ? id : `${id}.gguf`
  return path.join(modelsDir(env), file)
}

export function runtimeStatePath(env?: Record<string, string | undefined>): string {
  return path.join(runtimeDir(env), "runtime.json")
}

export const DEFAULT_RUNTIME_PORT = 8787

export type RuntimeState = { model?: string; port?: number }

export async function readRuntimeState(env?: Record<string, string | undefined>): Promise<RuntimeState> {
  const raw = await fs.readFile(runtimeStatePath(env), "utf8").catch(() => "")
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw)
    return {
      model: typeof parsed?.model === "string" ? parsed.model : undefined,
      port: typeof parsed?.port === "number" ? parsed.port : undefined,
    }
  } catch {
    return {}
  }
}

export async function writeRuntimeState(state: RuntimeState, env?: Record<string, string | undefined>): Promise<void> {
  await fs.mkdir(runtimeDir(env), { recursive: true })
  await fs.writeFile(runtimeStatePath(env), JSON.stringify(state, null, 2))
}

export type InstalledModel = { id: string; file: string; path: string; sizeBytes: number }

/** List GGUF models present in the models dir. The id is the filename without `.gguf`. */
export async function listInstalledModels(env?: Record<string, string | undefined>): Promise<InstalledModel[]> {
  const dir = modelsDir(env)
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
  const out: InstalledModel[] = []
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".gguf")) continue
    const full = path.join(dir, entry.name)
    const stat = await fs.stat(full).catch(() => undefined)
    out.push({
      id: entry.name.replace(/\.gguf$/i, ""),
      file: entry.name,
      path: full,
      sizeBytes: stat?.size ?? 0,
    })
  }
  return out.sort((a, b) => a.id.localeCompare(b.id))
}

export async function isEngineInstalled(env?: Record<string, string | undefined>, platform?: NodeJS.Platform): Promise<boolean> {
  return Boolean(await fs.stat(enginePath(env, platform)).catch(() => undefined))
}

/** True when an NVIDIA GPU + CUDA stack is usable, so install picks CUDA engine assets. */
export function detectAccel(hasNvidiaSmi: boolean, env: Record<string, string | undefined> = process.env): LocalRuntimeAccel {
  const forced = env.CODEGOBLIN_RUNTIME_ACCEL?.trim().toLowerCase()
  if (forced === "cpu" || forced === "cuda") return forced
  return hasNvidiaSmi ? "cuda" : "cpu"
}

/**
 * Pick the llama.cpp release assets (engine + optional CUDA runtime) matching this
 * platform/accel from a release's asset filenames. Pure so it can be unit-tested
 * against the real GitHub asset naming.
 */
export function selectEngineAssets(
  assetNames: string[],
  platform: NodeJS.Platform,
  accel: LocalRuntimeAccel,
): { engine?: string; cudart?: string } {
  const os = platform === "win32" ? "win" : platform === "darwin" ? "macos" : "ubuntu"
  const isEngine = (n: string) => /^llama-.*-bin-/.test(n) && !n.startsWith("cudart")

  if (os === "win" && accel === "cuda") {
    const cudaEngines = assetNames.filter((n) => isEngine(n) && /win-cuda/.test(n))
    const engine = pickCompatibleCuda(cudaEngines)
    const cudart = pickCompatibleCuda(assetNames.filter((n) => n.startsWith("cudart") && /win-cuda/.test(n)))
    return { engine, cudart }
  }
  if (os === "win") {
    const engine = assetNames.find((n) => isEngine(n) && /win-cpu/.test(n)) ?? assetNames.find((n) => isEngine(n) && /win/.test(n) && !/cuda/.test(n))
    return { engine }
  }
  if (os === "macos") {
    const arch = process.arch === "arm64" ? "arm64" : "x64"
    const engine = assetNames.find((n) => isEngine(n) && /macos/.test(n) && n.includes(arch)) ?? assetNames.find((n) => isEngine(n) && /macos/.test(n))
    return { engine }
  }
  const engine = assetNames.find((n) => isEngine(n) && /ubuntu/.test(n) && !/cuda/.test(n)) ?? assetNames.find((n) => isEngine(n) && /ubuntu/.test(n))
  return { engine }
}

/**
 * Among `llama-...-win-cuda-<major.minor>-x64.zip`, choose the *lowest* CUDA version —
 * older CUDA builds run on a wider range of installed drivers, so it is the safer default.
 */
function pickCompatibleCuda(names: string[]): string | undefined {
  let best: { name: string; ver: number } | undefined
  for (const name of names) {
    const match = name.match(/cuda-(\d+)\.(\d+)/)
    const ver = match ? Number(match[1]) * 1000 + Number(match[2]) : Number.MAX_SAFE_INTEGER
    if (!best || ver < best.ver) best = { name, ver }
  }
  return best?.name
}

export function catalogEntry(id: string): LocalModelCatalogEntry | undefined {
  return LOCAL_MODEL_CATALOG.find((entry) => entry.id === id.toLowerCase())
}
