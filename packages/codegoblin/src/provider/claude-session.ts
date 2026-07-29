import fs from "fs/promises"
import os from "os"
import path from "path"
import { lazy } from "@codegoblin/core/util/lazy"
import { registerDisposer } from "@/effect/instance-registry"
import { ptyPaste } from "./pty-input"

const pty = lazy(() => import("#pty"))
const NATIVE_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i

type Proc = Awaited<ReturnType<typeof pty>> extends { spawn: (...args: never[]) => infer R } ? R : never

export type ClaudeSendInput = {
  sessionID: string
  externalSessionID: string
  resume: boolean
  executable: string
  cwd: string
  modelID: string
  permissionMode: "agent" | "plan"
  effort?: "low" | "medium" | "high" | "xhigh" | "max"
  title?: string
  prompt: string
  requestWorkspaceTrust?: (directory: string) => Promise<boolean>
  onActivity?: (line: string) => void
  onThinking?: (delta: string) => void
  signal?: AbortSignal
  timeoutMs?: number
}

type Session = {
  proc: Proc
  externalSessionID: string
  cwd: string
  modelID: string
  permissionMode: string
  effort?: string
  transcript: string
  offset: number
  partial: string
  ready: boolean
  terminal: string
  busy: boolean
  lastUsed: number
}

const sessions = new Map<string, Session>()
const structuredSessions = new Set<string>()
const IDLE_MS = 10 * 60 * 1000
const MAX_TRANSCRIPT_READ = 8 * 1024 * 1024
const MAX_TRANSCRIPT_PARTIAL = 8 * 1024 * 1024
const MAX_RESPONSE_TEXT = 16 * 1024 * 1024
const MAX_STDERR = 1024 * 1024
let reaper: ReturnType<typeof setInterval> | undefined

registerDisposer(async (directory) => {
  for (const [id, session] of sessions) {
    if (session.cwd === directory) stop(id)
  }
})

function projectDir(cwd: string, home = os.homedir()) {
  return path.join(home, ".claude", "projects", cwd.replace(/[^a-zA-Z0-9_-]/g, "-"))
}

async function transcriptPath(cwd: string, externalSessionID: string, home = os.homedir()) {
  if (!NATIVE_ID.test(externalSessionID)) throw new Error("Invalid Claude session ID")
  const direct = path.join(projectDir(cwd, home), `${externalSessionID}.jsonl`)
  if (await fs.stat(direct).then(() => true).catch(() => false)) return direct
  const projects = path.join(home, ".claude", "projects")
  const dirs = await fs.readdir(projects, { withFileTypes: true }).catch(() => [])
  const matches = await Promise.all(
    dirs
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const candidate = path.join(projects, entry.name, `${externalSessionID}.jsonl`)
        return (await fs.stat(candidate).then(() => true).catch(() => false)) ? candidate : undefined
      }),
  )
  return matches.find(Boolean) ?? direct
}

export function claudeActivityFrom(record: Record<string, unknown>) {
  if (record.type !== "assistant") return
  const message = record.message as { content?: unknown } | undefined
  if (!Array.isArray(message?.content)) return
  const items = message.content.flatMap((item) => {
    if (!item || typeof item !== "object") return []
    const block = item as { type?: string; thinking?: string; name?: string }
    if (block.type === "thinking" && block.thinking?.trim()) return [block.thinking.trim()]
    if (block.type === "tool_use" && block.name) return [`Using ${block.name}`]
    return []
  })
  return items.join("\n") || undefined
}

export function claudeToolActivityFrom(record: Record<string, unknown>) {
  if (record.type !== "assistant") return
  const message = record.message as { content?: unknown } | undefined
  if (!Array.isArray(message?.content)) return
  const items = message.content.flatMap((item) => {
    if (!item || typeof item !== "object") return []
    const block = item as { type?: string; name?: string }
    return block.type === "tool_use" && block.name ? [`Using ${block.name}`] : []
  })
  return items.join("\n") || undefined
}

export function claudeAnswerFrom(record: Record<string, unknown>) {
  if (record.type !== "assistant") return
  const message = record.message as { content?: unknown } | undefined
  if (!Array.isArray(message?.content)) return
  const text = message.content
    .flatMap((item) => {
      if (!item || typeof item !== "object") return []
      const block = item as { type?: string; text?: string }
      return block.type === "text" && block.text ? [block.text] : []
    })
    .join("")
    .trim()
  return text || undefined
}

export function claudeTurnComplete(record: Record<string, unknown>) {
  return record.type === "system" && record.subtype === "turn_duration"
}

export function claudeStreamDeltaFrom(record: Record<string, unknown>) {
  if (record.type !== "stream_event" || !record.event || typeof record.event !== "object") return
  const event = record.event as { type?: string; delta?: unknown }
  if (event.type !== "content_block_delta" || !event.delta || typeof event.delta !== "object") return
  const delta = event.delta as { type?: string; thinking?: string; text?: string }
  if (delta.type === "thinking_delta" && delta.thinking) return { thinking: delta.thinking }
  if (delta.type === "text_delta" && delta.text) return { text: delta.text }
}

export function claudeUsageFrom(record: Record<string, unknown>) {
  if (record.type === "result" && record.usage && typeof record.usage === "object") return record.usage
  if (record.type !== "assistant") return
  const message = record.message as { usage?: unknown } | undefined
  return message?.usage && typeof message.usage === "object" ? message.usage : undefined
}

export function claudeUsageCollector() {
  const messages = new Map<string, Record<string, unknown>>()
  let result: Record<string, unknown> | undefined
  let anonymous = 0
  return {
    add(record: Record<string, unknown>) {
      const usage = claudeUsageFrom(record)
      if (!usage) return
      if (record.type === "result") {
        result = usage as Record<string, unknown>
        return
      }
      const message = record.message as { id?: unknown } | undefined
      const key =
        typeof message?.id === "string"
          ? message.id
          : typeof record.uuid === "string"
            ? record.uuid
            : `anonymous-${anonymous++}`
      messages.set(key, usage as Record<string, unknown>)
    },
    value() {
      if (result) return result
      const keys = [
        "input_tokens",
        "output_tokens",
        "cache_read_input_tokens",
        "cache_creation_input_tokens",
        "thinking_tokens",
      ] as const
      if (!messages.size) return
      return Object.fromEntries(
        keys.map((key) => [
          key,
          [...messages.values()].reduce((sum, usage) => sum + (typeof usage[key] === "number" ? usage[key] : 0), 0),
        ]),
      )
    },
  }
}

export function claudeTerminalReady(terminal: string) {
  return (
    terminal.includes("for agents") ||
    terminal.includes('Try "') ||
    terminal.includes("manual mode on") ||
    terminal.includes("auto mode on")
  )
}

export function claudeWorkspaceTrustRequired(terminal: string) {
  return (
    terminal.includes("Accessing") &&
    terminal.includes("workspace:") &&
    terminal.includes("trust") &&
    terminal.includes("Security")
  )
}

function stop(sessionID: string) {
  const session = sessions.get(sessionID)
  if (!session) return
  sessions.delete(sessionID)
  try {
    session.proc.kill()
  } catch {}
}

export function stopClaudeSession(sessionID: string) {
  stop(sessionID)
}

export function stopAllClaudeSessions() {
  for (const id of [...sessions.keys()]) stop(id)
}

function ensureReaper() {
  reaper ??= setInterval(() => {
    const now = Date.now()
    for (const [id, session] of sessions) {
      if (!session.busy && now - session.lastUsed > IDLE_MS) stop(id)
    }
    if (!sessions.size && reaper) {
      clearInterval(reaper)
      reaper = undefined
    }
  }, 60_000)
  reaper.unref?.()
}

async function syncOffset(session: Session) {
  session.offset = await fs.stat(session.transcript).then((stat) => stat.size).catch(() => 0)
  session.partial = ""
}

async function startSession(input: ClaudeSendInput) {
  const { spawn } = await pty()
  const transcript = await transcriptPath(input.cwd, input.externalSessionID)
  const proc = spawn(
    input.executable,
    [
      ...(input.modelID === "default" ? [] : ["--model", input.modelID]),
      "--permission-mode",
      input.permissionMode === "plan" ? "plan" : "auto",
      ...(input.effort ? ["--effort", input.effort] : []),
      ...(!input.resume && input.title?.trim() ? ["--name", input.title.trim().slice(0, 80)] : []),
      ...(input.resume ? ["--resume", input.externalSessionID] : ["--session-id", input.externalSessionID]),
    ],
    { name: "xterm-256color", cols: 140, rows: 45, cwd: input.cwd, env: process.env as Record<string, string> },
  )
  const session: Session = {
    proc,
    externalSessionID: input.externalSessionID,
    cwd: input.cwd,
    modelID: input.modelID,
    permissionMode: input.permissionMode,
    effort: input.effort,
    transcript,
    offset: 0,
    partial: "",
    ready: false,
    terminal: "",
    busy: true,
    lastUsed: Date.now(),
  }
  proc.onData((data) => {
    // Ink redraws the prompt in many small PTY writes, so readiness markers
    // are frequently split between callbacks. Match against a bounded rolling
    // buffer instead of requiring the whole marker to arrive in one chunk.
    session.terminal = `${session.terminal}${data}`.slice(-16_384)
    if (claudeTerminalReady(session.terminal)) session.ready = true
  })
  proc.onExit(() => {
    if (sessions.get(input.sessionID) === session) sessions.delete(input.sessionID)
  })
  sessions.set(input.sessionID, session)
  ensureReaper()

  let trustHandled = false
  for (let i = 0; i < 300 && !session.ready; i++) {
    if (claudeWorkspaceTrustRequired(session.terminal) && !trustHandled) {
      trustHandled = true
      const approved = await waitForWorkspaceTrust(input)
      if (!approved) {
        stop(input.sessionID)
        throw new Error(
          input.requestWorkspaceTrust
            ? `Claude workspace trust was not approved for ${input.cwd}.`
            : `Claude Code is waiting for workspace trust in ${input.cwd}. Open Claude in that folder once and approve its trust prompt, then retry.`,
        )
      }
      // Claude owns the trust record. CodeGoblin only confirms the currently
      // selected "Yes, I trust this folder" choice after its own permission UI
      // has received explicit approval for this exact directory.
      session.terminal = ""
      session.proc.write("\r")
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  if (!session.ready) {
    stop(input.sessionID)
    return
  }
  await syncOffset(session)
  return session
}

async function readNew(session: Session) {
  const handle = await fs.open(session.transcript, "r").catch(() => undefined)
  if (!handle) return []
  try {
    const stat = await handle.stat()
    if (stat.size <= session.offset) return []
    const buffer = Buffer.alloc(Math.min(stat.size - session.offset, MAX_TRANSCRIPT_READ))
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, session.offset)
    session.offset += bytesRead
    const value = `${session.partial}${buffer.subarray(0, bytesRead).toString("utf8")}`
    const lines = value.split(/\r?\n/)
    session.partial = lines.pop() ?? ""
    if (session.partial.length > MAX_TRANSCRIPT_PARTIAL) session.partial = ""
    return lines.flatMap((line) => {
      const trimmed = line.trim()
      if (!trimmed.startsWith("{")) return []
      try {
        return [JSON.parse(trimmed) as Record<string, unknown>]
      } catch {
        return []
      }
    })
  } finally {
    await handle.close().catch(() => {})
  }
}

async function hasNativeTurn(transcript: string) {
  const file = Bun.file(transcript)
  if (!(await file.exists())) return false
  const reader = file.stream().getReader()
  const decoder = new TextDecoder()
  let partial = ""
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      const lines = `${partial}${decoder.decode(next.value, { stream: true })}`.split(/\r?\n/)
      partial = lines.pop() ?? ""
      if (partial.length > MAX_TRANSCRIPT_PARTIAL) partial = ""
      for (const line of lines) {
        if (!line.trim().startsWith("{")) continue
        try {
          const record = JSON.parse(line) as Record<string, unknown>
          if (record.type === "user" && record.entrypoint === "cli") return true
        } catch {}
      }
    }
    partial += decoder.decode()
    if (!partial.trim().startsWith("{")) return false
    const record = JSON.parse(partial) as Record<string, unknown>
    return record.type === "user" && record.entrypoint === "cli"
  } catch {
    return false
  } finally {
    await reader.cancel().catch(() => {})
  }
}

async function limitedText(stream: ReadableStream<Uint8Array>, limit: number) {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let value = ""
  while (true) {
    const next = await reader.read()
    if (next.done) break
    value += decoder.decode(next.value, { stream: true })
    if (value.length > limit) {
      await reader.cancel().catch(() => {})
      throw new Error("Claude Code output exceeded the safety limit")
    }
  }
  return value + decoder.decode()
}

async function sendStructuredTurn(
  input: ClaudeSendInput,
): Promise<{ text: string; externalSessionID: string; usage?: unknown } | undefined> {
  if (input.signal?.aborted) return
  const proc = Bun.spawn(
    [
      input.executable,
      "--print",
      "--input-format",
      "text",
      "--output-format",
      "stream-json",
      "--include-partial-messages",
      "--verbose",
      "--permission-mode",
      input.permissionMode === "plan" ? "plan" : "auto",
      ...(input.effort ? ["--effort", input.effort] : []),
      ...(input.modelID === "default" ? [] : ["--model", input.modelID]),
      "--resume",
      input.externalSessionID,
    ],
    {
      cwd: input.cwd,
      env: process.env,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  proc.stdin.write(input.prompt)
  proc.stdin.end()

  const abort = () => proc.kill()
  input.signal?.addEventListener("abort", abort, { once: true })
  const timeout = setTimeout(abort, input.timeoutMs ?? 300_000)
  timeout.unref?.()
  const stderr = limitedText(proc.stderr, MAX_STDERR).catch((error) => {
    proc.kill()
    return error instanceof Error ? error.message : "Claude Code stderr exceeded the safety limit"
  })
  const reader = proc.stdout.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  let answer = ""
  const usage = claudeUsageCollector()

  const handle = (line: string) => {
    if (!line.trim().startsWith("{")) return
    const record = (() => {
      try {
        return JSON.parse(line) as Record<string, unknown>
      } catch {
        return
      }
    })()
    if (!record) return
    const delta = claudeStreamDeltaFrom(record)
    if (delta?.thinking) input.onThinking?.(delta.thinking)
    if (delta?.text) {
      answer += delta.text
      if (answer.length > MAX_RESPONSE_TEXT) throw new Error("Claude Code response exceeded the safety limit")
    }
    const activity = claudeToolActivityFrom(record)
    if (activity) input.onActivity?.(activity)
    usage.add(record)
  }

  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      buffer += decoder.decode(next.value, { stream: true })
      if (buffer.length > MAX_TRANSCRIPT_PARTIAL) {
        proc.kill()
        throw new Error("Claude Code stream line exceeded the safety limit")
      }
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() ?? ""
      for (const line of lines) handle(line)
    }
    buffer += decoder.decode()
    if (buffer.trim()) handle(buffer)
    const exitCode = await proc.exited
    if (exitCode !== 0) {
      const detail = (await stderr).trim()
      throw new Error(detail || `Claude Code exited with code ${exitCode}`)
    }
    const text = answer.trim()
    if (!text) return
    return { text, externalSessionID: input.externalSessionID, usage: usage.value() }
  } catch (error) {
    proc.kill()
    await reader.cancel().catch(() => undefined)
    throw error
  } finally {
    clearTimeout(timeout)
    input.signal?.removeEventListener("abort", abort)
  }
}

export async function sendToClaudeSession(
  input: ClaudeSendInput,
): Promise<{ text: string; externalSessionID: string; usage?: unknown } | undefined> {
  if (input.signal?.aborted) return
  const transcript = await transcriptPath(input.cwd, input.externalSessionID)
  if (await hasNativeTurn(transcript)) {
    if (structuredSessions.has(input.sessionID)) return
    structuredSessions.add(input.sessionID)
    stop(input.sessionID)
    try {
      return await sendStructuredTurn(input)
    } finally {
      structuredSessions.delete(input.sessionID)
    }
  }

  let session = sessions.get(input.sessionID)
  if (
    session &&
    (session.externalSessionID !== input.externalSessionID ||
      session.cwd !== input.cwd ||
      session.modelID !== input.modelID ||
      session.permissionMode !== input.permissionMode ||
      session.effort !== input.effort)
  ) {
    stop(input.sessionID)
    session = undefined
  }
  if (session?.busy) return
  if (!session) session = await startSession(input)
  if (!session) return

  session.busy = true
  await syncOffset(session)
  session.proc.write(`\x1b[200~${ptyPaste(input.prompt)}\x1b[201~`)
  // Claude collapses multiline bracketed paste into an attachment first. Give
  // the editor time to finish that transaction before Enter submits it.
  await new Promise((resolve) => setTimeout(resolve, 750))
  session.proc.write("\r")

  const abort = () => stop(input.sessionID)
  input.signal?.addEventListener("abort", abort, { once: true })
  const startedAt = Date.now()
  let answer: string | undefined
  const usage = claudeUsageCollector()
  let complete = false
  try {
    while (Date.now() - startedAt < (input.timeoutMs ?? 300_000)) {
      if (input.signal?.aborted || !sessions.has(input.sessionID)) return
      const records = await readNew(session)
      for (const record of records) {
        const activity = claudeActivityFrom(record)
        if (activity) input.onActivity?.(activity)
        const text = claudeAnswerFrom(record)
        if (text) {
          if (text.length > MAX_RESPONSE_TEXT) throw new Error("Claude Code response exceeded the safety limit")
          answer = text
        }
        usage.add(record)
        if (answer && claudeTurnComplete(record)) complete = true
      }
      if (complete) break
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  } finally {
    input.signal?.removeEventListener("abort", abort)
    const current = sessions.get(input.sessionID)
    if (current) {
      current.busy = false
      current.lastUsed = Date.now()
    }
  }

  if (!answer || !complete) {
    stop(input.sessionID)
    return
  }
  const result = { text: answer, externalSessionID: session.externalSessionID, usage: usage.value() }
  // A genuine interactive turn makes this session visible in Claude's native
  // picker. Follow-up turns can now use Claude's supported structured resume
  // mode, which exposes readable thinking while retaining that same UUID.
  stop(input.sessionID)
  return result
}

async function waitForWorkspaceTrust(input: ClaudeSendInput) {
  if (!input.requestWorkspaceTrust) return false
  if (input.signal?.aborted) return false
  return new Promise<boolean>((resolve) => {
    let settled = false
    const finish = (value: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      input.signal?.removeEventListener("abort", abort)
      resolve(value)
    }
    const abort = () => finish(false)
    const timeout = setTimeout(() => finish(false), input.timeoutMs ?? 300_000)
    timeout.unref?.()
    input.signal?.addEventListener("abort", abort, { once: true })
    void input.requestWorkspaceTrust!(input.cwd).then(finish, () => finish(false))
  })
}
