import { afterAll, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import type { ChildProcess } from "node:child_process"
import { spawn } from "../src/platform/process"
import { Global } from "../src/platform/paths"
import {
  LocalRuntime, contextFor, findEngine, installedModels, modelDirs, ownedEngineDir, ownedModelsDir,
  savePrefs, serverArgs, toolsFor, type RuntimeDeps,
} from "../src/core/local-runtime"
import { localCommand } from "../src/core/local-command"
import { runAgent } from "../src/core/agent"
import { PROVIDERS, pickerSection, refreshLocalModels, resolveSelection, selectionsByKind } from "../src/core/providers"

const FAKE = path.join(import.meta.dir, "fixtures", "fake-llama-server.ts")
const root = fs.mkdtempSync(path.join(process.env.CODEGOBLIN_TEST_SANDBOX!, "local-runtime-"))
const shared = path.join(root, "shared-models")
const engine = path.join(root, "engine", process.platform === "win32" ? "llama-server.exe" : "llama-server")
fs.mkdirSync(shared, { recursive: true })
fs.mkdirSync(path.dirname(engine), { recursive: true })
fs.writeFileSync(engine, "")
const gguf = (dir: string, name: string, bytes = 16) => { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, name), Buffer.alloc(bytes)) }
gguf(shared, "tiny-chat.gguf")
gguf(shared, "other-model.gguf")
gguf(shared, "vision-mmproj-f16.gguf")
gguf(shared, "split-00001-of-00002.gguf")
gguf(shared, "split-00002-of-00002.gguf")
fs.writeFileSync(path.join(shared, "half-downloaded.gguf.part"), "")

const env = { CODEGOBLIN_LOCAL_MODEL_DIRS: shared, CODEGOBLIN_LOCAL_ENGINE: engine }
const spawned: ChildProcess[] = []
const deps = (extra: Record<string, string> = {}, readyTimeoutMs = 10_000): RuntimeDeps => ({
  env,
  readyTimeoutMs,
  // The fake engine is a script, so it runs under bun in place of the configured binary.
  spawn: (command, options) => {
    const child = spawn([process.execPath, FAKE, ...command.slice(1)], { ...options, env: { ...options?.env, ...extra } })
    spawned.push(child)
    return child
  },
})
const exited = (child: ChildProcess) => child.exitCode !== null || child.signalCode !== null

afterAll(() => { for (const child of spawned) if (!exited(child)) child.kill() })

test("installed models: owned first, projectors, later shards and partial downloads skipped", () => {
  gguf(ownedModelsDir(), "Other-Model.gguf")
  try {
    const models = installedModels({ env })
    expect(models.map((model) => [model.id, model.source])).toEqual([
      ["Other-Model", "owned"], ["split-00001-of-00002", "shared"], ["tiny-chat", "shared"],
    ])
    expect(modelDirs({ CODEGOBLIN_LOCAL_MODEL_DIRS: "" }).map((entry) => entry.source)).toEqual(["owned"])
  } finally { fs.rmSync(path.join(ownedModelsDir(), "Other-Model.gguf")) }
})

test("an explicit engine is the only candidate; owned beats the fork's; CUDA is read off the build", () => {
  expect(findEngine({ CODEGOBLIN_LOCAL_ENGINE: path.join(root, "missing.exe") })).toBeUndefined()
  expect(findEngine(env)).toEqual({ path: engine, source: "configured", gpu: false })
  fs.writeFileSync(path.join(path.dirname(engine), process.platform === "win32" ? "ggml-cuda.dll" : "libggml-cuda.so"), "")
  expect(findEngine(env)?.gpu).toBe(true)
  expect(findEngine({ ...env, CODEGOBLIN_LOCAL_GPU: "0" })?.gpu).toBe(false)
  fs.mkdirSync(ownedEngineDir(), { recursive: true })
  fs.writeFileSync(path.join(ownedEngineDir(), path.basename(engine)), "")
  expect(findEngine({})?.source).toBe("owned")
})

test("tools by size unless chosen; context per model; nothing secret on the command line", () => {
  expect(toolsFor({ id: "tiny", sizeBytes: 2e9 }, {})).toEqual({ on: false, chosen: false })
  expect(toolsFor({ id: "big", sizeBytes: 5 * 1024 ** 3 }, {})).toEqual({ on: true, chosen: false })
  expect(toolsFor({ id: "bonsai-2-27b", sizeBytes: 1 }, {}).on).toBe(true)
  expect(toolsFor({ id: "tiny", sizeBytes: 2e9 }, { tiny: { tools: true } })).toEqual({ on: true, chosen: true })
  expect(contextFor({ id: "tiny" }, {})).toBe(16384)
  expect(contextFor({ id: "tiny" }, { tiny: { context: 8192 } })).toBe(8192)
  expect(contextFor({ id: "tiny" }, { tiny: { context: 100 } })).toBe(16384)
  const args = serverArgs({ model: { id: "bonsai-x", path: "m.gguf", sizeBytes: 1, source: "shared" }, port: 1234, context: 4096, gpu: true })
  expect(args.slice(args.indexOf("--host"), args.indexOf("--host") + 2)).toEqual(["--host", "127.0.0.1"])
  expect(args).toContain("q4_0")
  expect(args.join(" ")).not.toContain("api-key")
})

test("starts on demand, reuses the server for the same model, and proves it is ours by key", async () => {
  const runtime = new LocalRuntime(deps())
  const first = await runtime.acquire("tiny-chat")
  const second = await runtime.acquire("tiny-chat")
  try {
    expect(spawned.length).toBe(1)
    expect(runtime.status()).toMatchObject({ state: "ready", model: "tiny-chat", busy: 2 })
    expect(second.baseUrl).toBe(first.baseUrl)
    const anonymous = await fetch(first.baseUrl + "/models")
    expect(anonymous.status).toBe(401)
    const owned = await fetch(first.baseUrl + "/models", { headers: { authorization: "Bearer " + first.key } })
    expect(owned.status).toBe(200)
    const record = fs.readdirSync(path.join(Global.Path.state, "local", "servers"))
    expect(record).toEqual([process.pid + ".json"])
  } finally { first.release(); second.release(); await runtime.stop() }
  expect(exited(spawned[0]!)).toBe(true)
  expect(fs.readdirSync(path.join(Global.Path.state, "local", "servers"))).toEqual([])
})

test("another model is refused while one is answering, then swapped once it is free", async () => {
  const runtime = new LocalRuntime(deps())
  const busy = await runtime.acquire("tiny-chat")
  const before = spawned.at(-1)!
  await expect(runtime.acquire("other-model")).rejects.toThrow("answering with tiny-chat in another conversation")
  busy.release()
  const swapped = await runtime.acquire("other-model")
  try {
    expect(exited(before)).toBe(true)
    expect(runtime.status()).toMatchObject({ state: "ready", model: "other-model" })
  } finally { swapped.release(); await runtime.stop() }
})

test("a load that fails says why from the log; Stop during a load kills the server", async () => {
  const failing = new LocalRuntime(deps({ FAKE_LLAMA_EXIT: "1", FAKE_LLAMA_LOAD_MS: "60000" }))
  await expect(failing.acquire("tiny-chat")).rejects.toThrow(/stopped while loading tiny-chat[\s\S]*failed to load model/)
  expect(failing.status()).toMatchObject({ state: "stopped" })

  const slow = new LocalRuntime(deps({ FAKE_LLAMA_LOAD_MS: "60000" }))
  const stop = new AbortController()
  const pending = slow.acquire("tiny-chat", { signal: stop.signal })
  await Bun.sleep(300)
  stop.abort()
  await expect(pending).rejects.toBeDefined()
  const child = spawned.at(-1)!
  await Bun.sleep(200)
  expect(exited(child)).toBe(true)
  expect(slow.status()).toMatchObject({ state: "stopped", lastError: undefined })
  await expect(slow.acquire("not-installed")).rejects.toThrow("not installed")
})

test("an orphan whose CG-Next is gone is stopped; a live owner's or a stranger's is left alone", async () => {
  const servers = path.join(Global.Path.state, "local", "servers")
  fs.mkdirSync(servers, { recursive: true })
  const gone = spawn([process.execPath, "-e", "0"])
  await new Promise((resolve) => gone.once("exit", resolve))
  const start = (port: number, key: string) => {
    const child = spawn([process.execPath, FAKE, "--port", String(port), "--alias", "tiny-chat"], { env: { ...process.env, LLAMA_API_KEY: key, FAKE_LLAMA_LOAD_MS: "0" }, stdio: "ignore" })
    spawned.push(child)
    return child
  }
  const orphan = start(18901, "orphan-key")
  const stranger = start(18902, "someone-else")
  await Bun.sleep(600)
  fs.writeFileSync(path.join(servers, "1.json"), JSON.stringify({ ownerPid: gone.pid, pid: orphan.pid, port: 18901, key: "orphan-key", model: "tiny-chat", startedAt: 0 }))
  fs.writeFileSync(path.join(servers, "2.json"), JSON.stringify({ ownerPid: gone.pid, pid: stranger.pid, port: 18902, key: "recorded-key", model: "tiny-chat", startedAt: 0 }))
  fs.writeFileSync(path.join(servers, "3.json"), JSON.stringify({ ownerPid: process.pid === 1 ? 2 : process.ppid, pid: stranger.pid, port: 18902, key: "x", model: "tiny-chat", startedAt: 0 }))

  const runtime = new LocalRuntime(deps())
  const lease = await runtime.acquire("tiny-chat")
  lease.release()
  await runtime.stop()
  await Bun.sleep(300)
  expect(exited(orphan)).toBe(true)
  expect(exited(stranger)).toBe(false)
  expect(runtime.status().reclaimed).toEqual([`tiny-chat (pid ${orphan.pid})`])
  // A live owner's record is not ours to judge.
  expect(fs.readdirSync(servers).sort()).toEqual(["3.json"])
  stranger.kill()
  fs.rmSync(path.join(servers, "3.json"))
})

test("installed models land under Local in the catalogue and resolve by id", () => {
  const saved = process.env.CODEGOBLIN_LOCAL_MODEL_DIRS
  process.env.CODEGOBLIN_LOCAL_MODEL_DIRS = shared
  try {
    installedModels({ fresh: true })
    refreshLocalModels()
    const selection = resolveSelection("llama/tiny-chat")!
    expect(selection.provider.runtime).toBe(true)
    expect(selection.model.label).toContain("chat only")
    expect(pickerSection(selection)).toBe("Local models")
    const order = selectionsByKind().map((row) => pickerSection(row))
    expect(order.indexOf("Local models")).toBeGreaterThan(order.lastIndexOf("Text models"))
    expect(order.lastIndexOf("Local models")).toBeLessThan(order.indexOf("Image models"))
  } finally {
    if (saved === undefined) delete process.env.CODEGOBLIN_LOCAL_MODEL_DIRS
    else process.env.CODEGOBLIN_LOCAL_MODEL_DIRS = saved
    installedModels({ fresh: true })
    refreshLocalModels()
  }
})

test("/local reports, saves choices and refuses to stop a server mid-answer", async () => {
  const runtime = new LocalRuntime(deps())
  expect(await localCommand("", undefined, runtime)).toContain("Server: stopped")
  expect(await localCommand("tools on", undefined, runtime)).toContain("Name a local model")
  expect(await localCommand("tools on nope", "llama/nope", runtime)).toContain("not an installed local model")
  expect(await localCommand("context 12", "llama/tiny-chat", runtime)).toContain("2048 to 262144")
  const lease = await runtime.acquire("tiny-chat")
  expect(await localCommand("stop", undefined, runtime)).toContain("answering right now")
  lease.release()
  expect(await localCommand("stop", undefined, runtime)).toContain("Stopped llama-server (tiny-chat)")
  expect(await localCommand("stop", undefined, runtime)).toBe("No local model server is running.")
  savePrefs("tiny-chat", { tools: undefined, context: undefined })
})

test("a turn on a Local model loads it, sends the lease's key, and releases it after", async () => {
  // runAgent leases from the shared runtime; give it the fake engine for this test only.
  const { localRuntime } = await import("../src/core/local-runtime")
  const original = (localRuntime as unknown as { deps: RuntimeDeps }).deps
  ;(localRuntime as unknown as { deps: RuntimeDeps }).deps = deps()
  try {
    const provider = PROVIDERS.llama!
    const events = []
    const messages = [{ role: "system" as const, content: "agent instructions" }, { role: "user" as const, content: "hi" }]
    for await (const event of runAgent({ provider, modelId: "tiny-chat", apiKey: "", root: process.cwd(), messages })) events.push(event)
    expect(events[0]).toEqual({ type: "runtime", model: "tiny-chat", state: "loading" })
    expect(events[1]).toMatchObject({ type: "runtime", model: "tiny-chat", state: "ready" })
    expect(events).toContainEqual({ type: "text", delta: "hello from tiny-chat (chat)" })
    expect(localRuntime.status()).toMatchObject({ state: "ready", busy: 0 })
    // Already loaded: the next turn says nothing about loading.
    const again = []
    for await (const event of runAgent({ provider, modelId: "tiny-chat", apiKey: "", root: process.cwd(), messages: [...messages] })) again.push(event)
    expect(again.some((event) => event.type === "runtime")).toBe(false)
    // The shared provider never carries a lease's address or key.
    expect(provider.baseUrl).toBeUndefined()
  } finally {
    await localRuntime.stop()
    ;(localRuntime as unknown as { deps: RuntimeDeps }).deps = original
  }
})
