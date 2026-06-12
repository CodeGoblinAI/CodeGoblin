import { spawn } from "node:child_process"
import { openSync, readFileSync } from "node:fs"
import path from "path"
import { Process } from "@/util/process"
import { nativeBinPath } from "@/codegoblin/memory-native"
import {
  DEFAULT_RUNTIME_PORT,
  enginePath,
  isEngineInstalled,
  listInstalledModels,
  readRuntimeState,
  resolveRuntimeCtx,
  runtimeDir,
  writeRuntimeState,
} from "@/codegoblin/local-runtime"

/**
 * Keeps the local llama.cpp runtime matched to whatever local model the user picked, so
 * selecting a local model in the TUI/web picker "just works" — no manual `codegoblin runtime
 * start`, no Ctrl+C/restart dance when switching between local models.
 *
 * The runtime serves ONE model at a time (one llama-server process owning the VRAM). On each
 * local-model message we health-check the server, ask it which model it actually serves
 * (`/v1/models`), and start or swap as needed. The supervisor pid is tracked in runtime.json so
 * a swap kills exactly our own process tree — never a port-matched stranger.
 */

export type RuntimeAction = "none" | "start" | "restart" | "conflict"

/** Pure decision: what to do given server health, the model it serves, and the model we need. */
export function planRuntimeAction(input: {
  healthy: boolean
  served?: string
  requested: string
  pid?: number
}): RuntimeAction {
  if (!input.healthy) return "start"
  if (input.served && input.served === input.requested) return "none"
  if (input.pid) return "restart"
  return "conflict"
}

/** llama-server reports the model as a path or alias — normalize to the catalog/file id. */
export function modelIdFromServed(served: string): string {
  const base = served.split(/[\\/]/).pop() ?? served
  return base.replace(/\.gguf$/i, "")
}

async function runtimeHealthy(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1500) })
    return res.ok
  } catch {
    return false
  }
}

async function servedModelId(port: number): Promise<string | undefined> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/models`, { signal: AbortSignal.timeout(1500) })
    if (!res.ok) return undefined
    const body = (await res.json()) as { data?: { id?: string }[] }
    const id = body.data?.[0]?.id
    return id ? modelIdFromServed(id) : undefined
  } catch {
    return undefined
  }
}

async function killTree(pid: number): Promise<void> {
  if (process.platform === "win32") {
    await Process.run(["taskkill", "/PID", String(pid), "/T", "/F"]).catch(() => {})
    return
  }
  // The manager spawns the supervisor detached (its own process group), so the negative-pid
  // group kill takes llama-server down with it; fall back to a plain kill for foreground starts.
  try {
    process.kill(-pid, "SIGTERM")
  } catch {
    try {
      process.kill(pid, "SIGTERM")
    } catch {}
  }
}

async function waitFor(check: () => Promise<boolean>, timeoutMs: number, intervalMs = 500): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return true
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  return false
}

function runtimeLogPath(): string {
  return path.join(runtimeDir(), "llama.log")
}

function logTail(lines = 6): string {
  try {
    const raw = readFileSync(runtimeLogPath(), "utf8")
    return raw.trimEnd().split("\n").slice(-lines).join("\n")
  } catch {
    return ""
  }
}

/**
 * Spawn the supervised llama-server detached so it outlives this process (the chat server or
 * CLI may exit; the runtime keeps serving for the next message). Logs go to <runtime>/llama.log.
 */
export async function spawnLocalRuntime(input: {
  modelID: string
  modelPath: string
  port: number
  ctx: number
}): Promise<number> {
  const native = process.env.CODEGOBLIN_NATIVE_BIN || nativeBinPath()
  if (!native) throw new Error("codegoblin-native binary not found. Reinstall CodeGoblin or set CODEGOBLIN_NATIVE_BIN.")
  const log = openSync(runtimeLogPath(), "a")
  const child = spawn(
    native,
    [
      "llama",
      "--model", input.modelPath,
      "--engine", enginePath(),
      "--port", String(input.port),
      "--ngl", "99",
      "--ctx", String(input.ctx),
    ],
    { detached: true, stdio: ["ignore", log, log] },
  )
  child.unref()
  const pid = child.pid
  if (!pid) throw new Error("Failed to start the local runtime process.")
  await writeRuntimeState({ model: input.modelID, port: input.port, ctx: input.ctx, pid })

  const ready = await waitFor(async () => {
    if (child.exitCode !== null) return true // exited — stop waiting, handled below
    return runtimeHealthy(input.port)
  }, 180_000)
  if (child.exitCode !== null) {
    const tail = logTail()
    throw new Error(
      `The local runtime exited while loading '${input.modelID}'.` + (tail ? `\nLast log lines:\n${tail}` : ""),
    )
  }
  if (!ready) {
    await killTree(pid)
    throw new Error(`The local runtime did not become ready within 3 minutes loading '${input.modelID}'.`)
  }
  return pid
}

async function doEnsure(modelID: string): Promise<void> {
  const state = await readRuntimeState()
  const port = state.port ?? DEFAULT_RUNTIME_PORT
  const healthy = await runtimeHealthy(port)
  const served = healthy ? ((await servedModelId(port)) ?? state.model) : undefined
  const action = planRuntimeAction({ healthy, served, requested: modelID, pid: state.pid })
  if (action === "none") return
  if (action === "conflict")
    throw new Error(
      `Another server is running model '${served}' on port ${port} (not started by CodeGoblin). ` +
        `Stop it, or run \`codegoblin runtime start --model ${modelID}\` yourself.`,
    )

  if (action === "restart" && state.pid) {
    await killTree(state.pid)
    const freed = await waitFor(async () => !(await runtimeHealthy(port)), 10_000)
    if (!freed) throw new Error(`Could not stop the running local runtime (pid ${state.pid}) to switch models.`)
  }

  if (!(await isEngineInstalled()))
    throw new Error("Local engine not installed. Run `codegoblin runtime install` once, then retry.")
  const installed = await listInstalledModels()
  const match = installed.find((m) => m.id === modelID) ?? installed.find((m) => m.id.toLowerCase() === modelID.toLowerCase())
  if (!match)
    throw new Error(`Local model '${modelID}' is not downloaded. Run \`codegoblin runtime pull ${modelID}\`.`)

  await spawnLocalRuntime({
    modelID: match.id,
    modelPath: match.path,
    port,
    ctx: state.ctx ?? resolveRuntimeCtx(),
  })
}

let chain: Promise<void> = Promise.resolve()

/**
 * Make sure the local runtime is up and serving `modelID`, starting or swapping it if needed.
 * Serialized — concurrent messages while a model is loading wait for the same startup.
 */
export function ensureLocalRuntime(modelID: string): Promise<void> {
  const next = chain.catch(() => {}).then(() => doEnsure(modelID))
  chain = next
  return next
}

/** Stop the tracked runtime process, if any. Returns true if something was stopped. */
export async function stopLocalRuntime(): Promise<boolean> {
  const state = await readRuntimeState()
  const port = state.port ?? DEFAULT_RUNTIME_PORT
  if (!state.pid) return false
  await killTree(state.pid)
  await waitFor(async () => !(await runtimeHealthy(port)), 8_000)
  await writeRuntimeState({ ...state, pid: undefined })
  return true
}
