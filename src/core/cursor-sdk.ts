import path from "node:path"
import { workerCommand } from "../platform/self"
import { Global } from "../platform/paths"
import { apiKey } from "./auth"
import { PROVIDERS } from "./providers"
import { cursorEnvironment, cursorLoginUrl } from "./cursor-policy"
import type { AgentEvent } from "./agent"

type Mode = "cursor" | "cursor-api"
type Peer = { command?: string[] }
const object = (value: unknown) => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
const authPath = path.join(Global.Path.data, "cursor-sdk-auth.json")

/** A bounded, owned process boundary keeps SDK credentials and diagnostics out of CG history. */
async function* packets(input: { op: string; mode: Mode; apiKey?: string; prompt?: string; system?: string; modelId?: string }, signal?: AbortSignal, command?: string[], timeout = 15_000) {
  signal?.throwIfAborted()
  const proc = Bun.spawn(command ?? workerCommand("cursor", new URL("./cursor-worker.ts", import.meta.url)), {
    stdin: "pipe", stdout: "pipe", stderr: "pipe", windowsHide: true, env: cursorEnvironment(process.env),
  })
  const reader = proc.stdout.getReader()
  const stderr = proc.stderr.getReader()
  let stopTimer: ReturnType<typeof setTimeout> | undefined
  const stop = () => { if (proc.exitCode === null) proc.kill() }
  const cancel = () => {
    try { proc.stdin.write('{"cancel":true}\n'); proc.stdin.flush() } catch {}
    void reader.cancel().catch(() => {})
    stopTimer ??= setTimeout(stop, 2000)
  }
  signal?.addEventListener("abort", cancel, { once: true })
  const timer = setTimeout(cancel, timeout)
  const diagnostics = (async () => { while (!(await stderr.read()).done) {} })().catch(() => {})
  let done = false
  try {
    signal?.throwIfAborted()
    proc.stdin.write(JSON.stringify({ ...input, authPath, storePath: path.join(Global.Path.cache, "cursor-sdk-runs", crypto.randomUUID()), workspaceRoot: path.join(Global.Path.tmp, "cursor-sdk") }) + "\n")
    proc.stdin.flush()
    let buffer = ""
    let bytes = 0
    const decoder = new TextDecoder()
    for (;;) {
      const part = await reader.read()
      if (part.done) break
      signal?.throwIfAborted()
      bytes += part.value.byteLength
      if (bytes > 16 * 1024 * 1024) throw new Error("Cursor SDK output exceeded the safety limit")
      buffer += decoder.decode(part.value, { stream: true })
      const lines = buffer.split("\n")
      buffer = lines.pop() || ""
      for (const line of lines) {
        if (!line.trim()) continue
        let packet: Record<string, unknown>
        try { packet = object(JSON.parse(line)) } catch { throw new Error("Cursor SDK returned an invalid response") }
        if (packet.type === "error") throw new Error(packet.code === "signed-out" ? input.mode === "cursor" ? "Run /login cursor for SDK user-plan access (CLI login is separate)" : "Use /connect cursor-api or CURSOR_API_KEY" : "Cursor SDK request failed; check sign-in, quota and SDK compatibility")
        if (done) throw new Error("Cursor SDK sent data after completion")
        if (packet.type === "done") done = true
        else yield packet
      }
    }
    signal?.throwIfAborted()
    if (buffer.trim() || await proc.exited !== 0 || !done) throw new Error("Cursor SDK stopped before completion (possibly timed out)")
  } finally {
    clearTimeout(timer)
    if (stopTimer) clearTimeout(stopTimer)
    signal?.removeEventListener("abort", cancel)
    stop()
    proc.stdin.end()
    await Promise.all([reader.cancel().catch(() => {}), stderr.cancel().catch(() => {})])
    await proc.exited
    await diagnostics
  }
}

export async function cursorAuthStatus(mode: Mode, peer: Peer = {}) {
  const key = mode === "cursor-api" ? apiKey(mode) : undefined
  if (mode === "cursor-api" && !key && !peer.command) return { ready: false, detail: "Use /connect cursor-api or CURSOR_API_KEY (key owner is billed)" }
  try {
    let ready = false
    for await (const packet of packets({ op: "status", mode, apiKey: key }, undefined, peer.command)) if (packet.type === "status") ready = packet.ready === true
    if (!ready) return { ready: false, detail: mode === "cursor" ? "Run /login cursor; SDK browser login is separate from Cursor CLI login" : "Use /connect cursor-api or CURSOR_API_KEY" }
    // Catalog failure must not erase a usable key or claim the account is signed out.
    let catalogAvailable = false
    await (async () => {
      for await (const packet of packets({ op: "models", mode, apiKey: key }, undefined, peer.command)) {
        if (packet.type !== "models" || !Array.isArray(packet.models)) continue
        const models = packet.models.slice(0, 200).flatMap((entry) => {
          const model = object(entry)
          if (typeof model.id !== "string" || !/^[A-Za-z0-9._:-]{1,120}$/.test(model.id) || model.id === "default") return []
          return [{ id: model.id, label: typeof model.label === "string" ? model.label.replace(/[\x00-\x1f\x7f]/g, "").slice(0, 100) : model.id, contextWindow: 0, effort: false }]
        })
        if (models.length && PROVIDERS[mode]) {
          PROVIDERS[mode].models = [{ id: "default", label: "Auto (official selection)", contextWindow: 0, effort: false }, ...models]
          catalogAvailable = true
        }
      }
    })().catch(() => {})
    if (!catalogAvailable && PROVIDERS[mode]) PROVIDERS[mode].models = [{ id: "default", label: "Auto (official selection)", contextWindow: 0, effort: false }]
    return { ready: true, detail: (mode === "cursor" ? "SDK user-plan key stored; CG-Next owns approvals." : "SDK explicit key configured; billed to its user/team.") + (catalogAvailable ? " Context, price and quota unavailable." : " Catalog unavailable; key access not verified. Context, price and quota unavailable.") }
  } catch { return { ready: false, detail: mode === "cursor" ? "Could not read Cursor SDK sign-in; check SDK compatibility or use /login cursor" : "Could not read Cursor SDK key status; check SDK compatibility or /connect cursor-api" } }
}

export async function* cursorChat(input: { mode: Mode; modelId: string; prompt: string; system: string; apiKey?: string; signal?: AbortSignal; command?: string[] }): AsyncGenerator<Extract<AgentEvent, { type: "text" | "thinking" | "spend" }>> {
  if (input.prompt.length + input.system.length > 500_000) throw new Error("Cursor conversation is too large; shorten the prompt or start a new session")
  for await (const packet of packets({ op: "completion", mode: input.mode, modelId: input.modelId, prompt: input.prompt, system: input.system, apiKey: input.mode === "cursor-api" ? input.apiKey : undefined }, input.signal, input.command, 10 * 60_000)) {
    if ((packet.type === "text" || packet.type === "thinking") && typeof packet.delta === "string") { yield { type: packet.type, delta: packet.delta }; continue }
    if (packet.type === "spend" && Number.isSafeInteger(packet.input) && Number.isSafeInteger(packet.output) && (packet.input as number) >= 0 && (packet.output as number) >= 0) { yield { type: "spend", input: packet.input as number, output: packet.output as number }; continue }
    throw new Error("Cursor SDK returned an unexpected event; inference stopped for safety")
  }
}

/** Starts only after the UI's explicit warning/Start action, never on application startup. */
export async function startCursorLogin(peer: Peer = {}) {
  const controller = new AbortController()
  const expiresAt = Date.now() + 5 * 60_000
  let state: "pending" | "complete" | "failed" | "cancelled" = "pending"
  let resolveUrl!: (url: string) => void
  let rejectUrl!: (error: Error) => void
  const url = new Promise<string>((resolve, reject) => { resolveUrl = resolve; rejectUrl = reject })
  let received = false
  const reading = (async () => {
    try {
      for await (const packet of packets({ op: "login", mode: "cursor" }, controller.signal, peer.command, 5 * 60_000)) {
        if (packet.type !== "url" || received || typeof packet.url !== "string") throw new Error("Invalid sign-in response")
        resolveUrl(cursorLoginUrl(packet.url)); received = true
      }
      if (state === "pending") state = received ? "complete" : "failed"
    } catch { if (state === "pending") state = "failed" }
    finally { rejectUrl(new Error("Could not start Cursor SDK sign-in")) }
  })()
  const timer = setTimeout(() => { state = "cancelled"; controller.abort() }, 5 * 60_000)
  void reading.finally(() => clearTimeout(timer))
  try {
    return { url: await Promise.race([url, new Promise<string>((_, reject) => setTimeout(() => reject(new Error("Cursor SDK sign-in startup timed out")), 15_000).unref())]), expiresAt,
      status: () => Date.now() >= expiresAt && state === "pending" ? "expired" : state,
      cancel: async () => { if (state === "pending") state = "cancelled"; controller.abort(); await reading } }
  } catch { controller.abort(); await reading; throw new Error("Could not start Cursor SDK sign-in; check SDK compatibility") }
}
