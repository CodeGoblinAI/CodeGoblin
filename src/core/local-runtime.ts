import fs from "node:fs"
import net from "node:net"
import path from "node:path"
import { randomBytes } from "node:crypto"
import type { ChildProcess } from "node:child_process"
import { spawn } from "../platform/process"
import { Global } from "../platform/paths"

/**
 * CG-Next's own llama.cpp runtime.
 *
 * Pick an installed GGUF under Local and CG-Next starts llama-server for it,
 * swaps it when another local model is picked, and stops it when this process
 * ends. One server per CG-Next process, as a child rather than a detached
 * daemon: a server that outlives the window that started it holds gigabytes of
 * VRAM and RAM nobody remembers asking for.
 *
 * Ownership is proven, never assumed from a port. Each start gets a random API
 * key, and a server is only ours if it answers to that key. The fork's runtime
 * (runtime/runtime.json, port 8787) is read for its engine and models and is
 * never treated as ours, stopped or swapped.
 *
 * The external route (CODEGOBLIN_LOCAL_URL, provider "local") is untouched:
 * that server belongs to whoever started it.
 */

type Env = Record<string, string | undefined>

export type ModelFile = {
  /** The filename without .gguf, made safe to use as a model id. */
  id: string
  path: string
  sizeBytes: number
  /** Owned files are CG-Next's to replace; shared ones are only read. */
  source: "owned" | "shared"
}

export type Engine = { path: string; source: "owned" | "configured" | "shared"; gpu: boolean }

export type ModelPrefs = { tools?: boolean; context?: number }

const exe = (platform: NodeJS.Platform = process.platform) => platform === "win32" ? "llama-server.exe" : "llama-server"
const sharedRuntime = () => path.join(Global.Path.home, ".local", "share", "codegoblin", "runtime")

export const ownedDir = () => path.join(Global.Path.data, "local")
export const ownedModelsDir = () => path.join(ownedDir(), "models")
export const ownedEngineDir = () => path.join(ownedDir(), "engine")
const stateDir = () => path.join(Global.Path.state, "local")
const serversDir = () => path.join(stateDir(), "servers")
export const logPath = () => path.join(stateDir(), "llama-server.log")
const prefsPath = () => path.join(stateDir(), "models.json")

/**
 * Where GGUFs are looked for, owned first.
 *
 * By default that is CG-Next's own folder, the folder earlier CG-Next tests
 * downloaded into, and the fork's model folder - read, never written, so a
 * 6 GB model already on disk is not downloaded twice.
 * CODEGOBLIN_LOCAL_MODEL_DIRS replaces the shared ones (empty means none).
 */
export function modelDirs(env: Env = process.env): { dir: string; source: ModelFile["source"] }[] {
  const shared = env.CODEGOBLIN_LOCAL_MODEL_DIRS !== undefined
    ? env.CODEGOBLIN_LOCAL_MODEL_DIRS.split(path.delimiter).map((entry) => entry.trim()).filter(Boolean)
    : [path.join(Global.Path.home, ".local", "share", "cg-next", "models"), path.join(sharedRuntime(), "models")]
  return [{ dir: ownedModelsDir(), source: "owned" as const }, ...shared.map((dir) => ({ dir: path.resolve(dir), source: "shared" as const }))]
}

/** Vision projectors and the later parts of a split model are not models to pick. */
function pickable(name: string) {
  if (!name.toLowerCase().endsWith(".gguf") || /mmproj/i.test(name)) return false
  const shard = /-(\d{5})-of-\d{5}\.gguf$/i.exec(name)
  return !shard || shard[1] === "00001"
}

export const modelIdOf = (file: string) => file.replace(/\.gguf$/i, "").replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 120)

let scan: { at: number; models: ModelFile[] } = { at: 0, models: [] }

/**
 * Every installed GGUF, deduplicated by id with owned copies winning.
 *
 * Cheap enough to call from a picker - a few directory reads - and cached for
 * two seconds anyway, since a palette asks on every keystroke.
 */
export function installedModels(options: { env?: Env; fresh?: boolean } = {}): ModelFile[] {
  if (!options.env && !options.fresh && Date.now() - scan.at < 2000) return scan.models
  const seen = new Set<string>()
  const models: ModelFile[] = []
  for (const { dir, source } of modelDirs(options.env)) {
    let entries: fs.Dirent[]
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { continue }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isFile() || !pickable(entry.name)) continue
      const id = modelIdOf(entry.name)
      if (!id || seen.has(id.toLowerCase())) continue
      const full = path.join(dir, entry.name)
      let sizeBytes = 0
      try { sizeBytes = fs.statSync(full).size } catch { continue }
      seen.add(id.toLowerCase())
      models.push({ id, path: full, sizeBytes, source })
    }
  }
  if (!options.env) scan = { at: Date.now(), models }
  return models
}

/**
 * The llama-server to run.
 *
 * CODEGOBLIN_LOCAL_ENGINE, when set, is the only candidate - an explicit
 * choice that is missing is reported, not quietly replaced. Otherwise
 * CG-Next's own engine folder, then the fork's (read-only use: running an
 * executable changes nothing on disk).
 */
export function findEngine(env: Env = process.env, platform: NodeJS.Platform = process.platform): Engine | undefined {
  const configured = env.CODEGOBLIN_LOCAL_ENGINE?.trim()
  const candidates: [string, Engine["source"]][] = configured
    ? [[path.resolve(configured), "configured"]]
    : [[path.join(ownedEngineDir(), exe(platform)), "owned"], [path.join(sharedRuntime(), "engine", exe(platform)), "shared"]]
  for (const [file, source] of candidates) {
    if (!fs.existsSync(file)) continue
    const cuda = fs.existsSync(path.join(path.dirname(file), platform === "win32" ? "ggml-cuda.dll" : "libggml-cuda.so"))
    return { path: file, source, gpu: cuda && env.CODEGOBLIN_LOCAL_GPU !== "0" }
  }
  return undefined
}

export function readPrefs(): Record<string, ModelPrefs> {
  try {
    const raw = JSON.parse(fs.readFileSync(prefsPath(), "utf8"))
    return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}
  } catch { return {} }
}

export function savePrefs(id: string, patch: ModelPrefs) {
  const all = readPrefs()
  const next = { ...all[id], ...patch }
  for (const key of Object.keys(next) as (keyof ModelPrefs)[]) if (next[key] === undefined) delete next[key]
  all[id] = next
  fs.mkdirSync(stateDir(), { recursive: true })
  const temp = prefsPath() + "." + process.pid + ".tmp"
  fs.writeFileSync(temp, JSON.stringify(all, null, 2))
  fs.renameSync(temp, prefsPath())
}

/** Large enough to be worth offering tools to: under this, small models mostly misuse them. */
const TOOLS_FROM_BYTES = 4 * 1024 ** 3
export const isBonsai = (id: string) => /bonsai/i.test(id)

/**
 * Whether a local model is offered CG's tools.
 *
 * A choice made with /local tools wins. Otherwise size decides, and says so:
 * a 1.7B model handed fourteen tool schemas spends its context reading them
 * and then calls the wrong one.
 */
export function toolsFor(model: Pick<ModelFile, "id" | "sizeBytes">, prefs = readPrefs()): { on: boolean; chosen: boolean } {
  const chosen = prefs[model.id]?.tools
  if (typeof chosen === "boolean") return { on: chosen, chosen: true }
  return { on: model.sizeBytes >= TOOLS_FROM_BYTES || isBonsai(model.id), chosen: false }
}

export const DEFAULT_CONTEXT = 16384

export function contextFor(model: Pick<ModelFile, "id">, prefs = readPrefs()): number {
  const chosen = prefs[model.id]?.context
  if (typeof chosen === "number" && Number.isInteger(chosen) && chosen >= 2048) return chosen
  return isBonsai(model.id) ? 32768 : DEFAULT_CONTEXT
}

/**
 * Flags Bonsai's ternary weights need on the fork's engine: a Q4 KV cache so
 * 32k context fits in 8 GB, flash attention, and its base sampling. Carried
 * over from the fork, where they were measured.
 */
const BONSAI_ARGS = ["--cache-type-k", "q4_0", "--cache-type-v", "q4_0", "-fa", "on", "--temp", "1.0", "--top-p", "0.95", "--top-k", "20"]

export function serverArgs(input: { model: ModelFile; port: number; context: number; gpu: boolean }): string[] {
  return [
    "--model", input.model.path,
    "--alias", input.model.id,
    "--host", "127.0.0.1",
    "--port", String(input.port),
    "--ctx-size", String(input.context),
    "--n-gpu-layers", input.gpu ? "99" : "0",
    // One slot: follow-up turns reuse its prompt cache instead of re-reading
    // the whole conversation, and a summary waits rather than fighting for VRAM.
    "--parallel", "1",
    "--jinja",
    "--no-webui",
    ...(isBonsai(input.model.id) ? BONSAI_ARGS : []),
  ]
}

export function logTail(lines = 6): string {
  try {
    const raw = fs.readFileSync(logPath(), "utf8")
    return raw.slice(-4000).trimEnd().split(/\r?\n/).filter((line) => line.trim()).slice(-lines).join("\n")
  } catch { return "" }
}

const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM" } }

const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  const timer = setTimeout(resolve, ms)
  signal?.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason) }, { once: true })
})

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer()
    probe.once("error", reject)
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address()
      probe.close(() => typeof address === "object" && address ? resolve(address.port) : reject(new Error("no free port")))
    })
  })
}

/** Does the server on this port answer to this key with this model? Then it is ours. */
async function answersAsOurs(port: number, key: string, model: string): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/v1/models`, { headers: { authorization: "Bearer " + key }, signal: AbortSignal.timeout(1500) })
    if (!response.ok) return false
    const body = await response.json() as { data?: { id?: string; aliases?: string[] }[] }
    return Array.isArray(body.data) && body.data.some((entry) => entry.id === model || entry.aliases?.includes(model))
  } catch { return false }
}

type OwnerRecord = { ownerPid: number; pid: number; port: number; key: string; model: string; startedAt: number }

export type RuntimeStatus =
  | { state: "stopped"; lastError?: string; reclaimed: string[] }
  | { state: "loading" | "ready"; model: string; port: number; pid: number; context: number; gpu: boolean; since: number; busy: number; reclaimed: string[]; lastError?: undefined }

export type Lease = { baseUrl: string; key: string; model: ModelFile; tools: boolean; release(): void }

type Running = {
  child: ChildProcess; model: ModelFile; port: number; key: string; context: number; gpu: boolean
  startedAt: number; ready: boolean; leases: number; stopping: boolean
}

export type RuntimeDeps = {
  spawn: (command: string[], options: Parameters<typeof spawn>[1]) => ChildProcess
  env: Env
  readyTimeoutMs: number
}

export class LocalRuntime {
  private running?: Running
  private chain: Promise<unknown> = Promise.resolve()
  private lastError?: string
  private reclaimedOnce = false
  private reclaimed: string[] = []
  private exitHooked = false

  constructor(private deps: RuntimeDeps = { spawn, env: process.env, readyTimeoutMs: 180_000 }) {}

  status(): RuntimeStatus {
    const run = this.running
    if (!run) return { state: "stopped", lastError: this.lastError, reclaimed: this.reclaimed }
    return {
      state: run.ready ? "ready" : "loading", model: run.model.id, port: run.port, pid: run.child.pid ?? 0,
      context: run.context, gpu: run.gpu, since: run.startedAt, busy: run.leases, reclaimed: this.reclaimed,
    }
  }

  /** True when this model is already loaded and answering - nothing to wait for. */
  serving(modelId: string): boolean {
    return Boolean(this.running?.ready && this.running.model.id === modelId && this.running.child.exitCode === null)
  }

  /**
   * The server for this model, started or swapped as needed, held until
   * release(). Serialized: a second request while a model loads waits for the
   * same load. A different model while another conversation holds the server
   * is refused rather than pulled out from under that answer.
   */
  acquire(modelId: string, options: { signal?: AbortSignal } = {}): Promise<Lease> {
    const next = this.chain.catch(() => {}).then(() => this.acquireNow(modelId, options.signal))
    this.chain = next
    return next
  }

  private async acquireNow(modelId: string, signal?: AbortSignal): Promise<Lease> {
    signal?.throwIfAborted()
    await this.reclaim()
    const model = installedModels({ env: this.deps.env === process.env ? undefined : this.deps.env, fresh: true }).find((entry) => entry.id === modelId)
    if (!model) throw new Error(`Local model ${modelId} is not installed. /local lists installed models and where they are looked for.`)
    let run = this.running
    if (run && (run.child.exitCode !== null || run.stopping)) run = this.running = undefined
    if (run && run.model.id !== modelId) {
      if (run.leases > 0) throw new Error(`The local runtime is answering with ${run.model.id} in another conversation. Wait for it to finish, or pick ${run.model.id}.`)
      await this.stopNow()
      run = undefined
    }
    if (!run) run = await this.start(model, signal)
    run.leases++
    let released = false
    const held = run
    return {
      baseUrl: `http://127.0.0.1:${run.port}/v1`, key: run.key, model: run.model, tools: toolsFor(run.model).on,
      release: () => { if (!released) { released = true; held.leases = Math.max(0, held.leases - 1) } },
    }
  }

  private async start(model: ModelFile, signal?: AbortSignal): Promise<Running> {
    const engine = findEngine(this.deps.env)
    if (!engine) {
      throw new Error(this.deps.env.CODEGOBLIN_LOCAL_ENGINE?.trim()
        ? `CODEGOBLIN_LOCAL_ENGINE points at ${this.deps.env.CODEGOBLIN_LOCAL_ENGINE}, which does not exist.`
        : `No llama-server found. Put llama.cpp's server in ${ownedEngineDir()} or set CODEGOBLIN_LOCAL_ENGINE.`)
    }
    const context = contextFor(model)
    const key = randomBytes(24).toString("hex")
    const port = await freePort()
    fs.mkdirSync(serversDir(), { recursive: true })
    const log = fs.openSync(logPath(), "w")
    let child: ChildProcess
    try {
      child = this.deps.spawn([engine.path, ...serverArgs({ model, port, context, gpu: engine.gpu })], {
        cwd: path.dirname(engine.path),
        stdio: ["ignore", log, log],
        // The key travels in the environment so it is not on the command line.
        env: { ...process.env, LLAMA_API_KEY: key },
      })
    } finally { fs.closeSync(log) }
    // A one-shot prompt should exit when its answer is done; the exit hook
    // below still takes the server with it.
    child.unref()
    const run: Running = { child, model, port, key, context, gpu: engine.gpu, startedAt: Date.now(), ready: false, leases: 0, stopping: false }
    this.running = run
    this.lastError = undefined
    this.hookExit()
    const record: OwnerRecord = { ownerPid: process.pid, pid: child.pid ?? 0, port, key, model: model.id, startedAt: run.startedAt }
    fs.writeFileSync(this.recordPath(), JSON.stringify(record))
    child.once("exit", (code) => {
      if (this.running === run) {
        this.running = undefined
        if (!run.stopping) this.lastError = `llama-server stopped unexpectedly (exit ${code ?? "signal"}) serving ${model.id}.` + (logTail() ? "\n" + logTail() : "")
        this.removeRecord()
      }
    })

    const deadline = Date.now() + this.deps.readyTimeoutMs
    try {
      while (true) {
        signal?.throwIfAborted()
        if (child.exitCode !== null || this.running !== run) {
          const tail = logTail()
          throw new Error(`llama-server stopped while loading ${model.id}.` + (tail ? "\nLast log lines:\n" + tail : ""))
        }
        try {
          const health = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) })
          if (health.ok && await answersAsOurs(port, key, model.id)) break
        } catch {}
        if (Date.now() > deadline) throw new Error(`llama-server did not become ready within ${Math.round(this.deps.readyTimeoutMs / 1000)} s loading ${model.id}.`)
        await sleep(250, signal)
      }
    } catch (error) {
      await this.stopNow()
      if (!signal?.aborted) this.lastError = error instanceof Error ? error.message : String(error)
      throw error
    }
    run.ready = true
    return run
  }

  /** Stop our server, if there is one. Waits until it has gone, so its VRAM is free. */
  stop(): Promise<boolean> {
    const next = this.chain.catch(() => {}).then(() => this.stopNow())
    this.chain = next
    return next
  }

  private async stopNow(): Promise<boolean> {
    const run = this.running
    if (!run) return false
    run.stopping = true
    const exited = run.child.exitCode !== null ? Promise.resolve() : new Promise<void>((resolve) => run.child.once("exit", () => resolve()))
    run.child.kill()
    await Promise.race([exited, sleep(5000)])
    if (this.running === run) this.running = undefined
    this.removeRecord()
    return true
  }

  /**
   * Servers an earlier CG-Next run left behind when it was killed outright.
   *
   * Only ones whose owning CG-Next process is gone, and only if the server on
   * the recorded port still answers to the recorded key with the recorded
   * model. Anything else - a live window's server, a stranger that took the
   * port - is left alone; only the stale record is dropped.
   */
  private async reclaim() {
    if (this.reclaimedOnce) return
    this.reclaimedOnce = true
    let files: string[]
    try { files = fs.readdirSync(serversDir()).filter((name) => name.endsWith(".json")) } catch { return }
    for (const name of files) {
      const file = path.join(serversDir(), name)
      let record: OwnerRecord
      try { record = JSON.parse(fs.readFileSync(file, "utf8")) } catch { fs.rmSync(file, { force: true }); continue }
      if (record.ownerPid === process.pid || alive(record.ownerPid)) continue
      if (record.pid && alive(record.pid) && await answersAsOurs(record.port, record.key, record.model)) {
        try { process.kill(record.pid) } catch {}
        this.reclaimed.push(`${record.model} (pid ${record.pid})`)
      }
      fs.rmSync(file, { force: true })
    }
  }

  private recordPath() { return path.join(serversDir(), `${process.pid}.json`) }
  private removeRecord() { try { fs.rmSync(this.recordPath(), { force: true }) } catch {} }

  /** A child is not killed when its parent exits on Windows; this does it. */
  private hookExit() {
    if (this.exitHooked) return
    this.exitHooked = true
    process.on("exit", () => {
      const run = this.running
      if (!run) return
      run.stopping = true
      try { run.child.kill() } catch {}
      this.removeRecord()
    })
  }
}

export const localRuntime = new LocalRuntime()
