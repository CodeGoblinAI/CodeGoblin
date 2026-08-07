import fs from "fs/promises"
import os from "os"
import path from "path"
import { lazy } from "@codegoblin/core/util/lazy"
import { registerDisposer } from "@/effect/instance-registry"
import { ptyPaste } from "./pty-input"

/**
 * Warm Antigravity sessions.
 *
 * Every `agy --print` run pays ~20s of auth/workspace setup before it answers,
 * and resuming a conversation is worse, so a chat that should feel instant
 * stalls on each turn. An interactive `agy -i` pays that once and then answers
 * in about a second (measured: 16.7s cold, 1.1s warm), so a session is kept
 * alive per CodeGoblin session and prompts are typed into it.
 *
 * Input goes through the pty; output is read from the conversation transcript
 * rather than the terminal, because scraping a TUI would mean stripping
 * spinners, chrome and redraws out of the assistant's prose. The transcript is
 * already structured:
 *
 *   ~/.gemini/antigravity-cli/brain/<id>/.system_generated/logs/transcript_full.jsonl
 *
 * A `PLANNER_RESPONSE` carrying `tool_calls` is a step (activity); one carrying
 * `content` and no tool calls is the answer.
 */

const pty = lazy(() => import("#pty"))
const NATIVE_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i

type Proc = Awaited<ReturnType<typeof pty>> extends { spawn: (...args: never[]) => infer R } ? R : never

export type AntigravitySendInput = {
  sessionID: string
  conversationID?: string
  executable: string
  cwd: string
  modelID: string
  permissionMode: "agent" | "plan"
  prompt: string
  onActivity?: (line: string) => void
  signal?: AbortSignal
  /** Overridable so tests do not wait on real timings. */
  answerQuietMs?: number
  timeoutMs?: number
}

type Session = {
  proc: Proc
  cwd: string
  modelID: string
  permissionMode: string
  conversationID?: string
  transcript?: string
  offset: number
  partial: string
  lastUsed: number
  busy: boolean
  /** Tail of the pty output, enough to see which footer state came last. */
  terminal: string
}

/**
 * AGY's footer says which state it is in: "esc to cancel" while a turn is
 * running, "? for shortcuts" once the prompt is idle again. Whichever appears
 * later in the output is the current state — comparing positions also survives
 * a marker being split across pty writes, which a plain `includes` on a single
 * chunk does not.
 */
export function antigravityIdle(terminal: string) {
  return terminal.lastIndexOf("for shortcuts") > terminal.lastIndexOf("esc to cancel")
}

const sessions = new Map<string, Session>()
const MAX_TRANSCRIPT_READ = 8 * 1024 * 1024
const MAX_TRANSCRIPT_PARTIAL = 8 * 1024 * 1024
/** A warm process is only worth keeping while the chat is active. */
const IDLE_MS = 10 * 60 * 1000
let reaper: ReturnType<typeof setInterval> | undefined

registerDisposer(async (directory) => {
  for (const [id, session] of sessions) {
    if (session.cwd === directory) stop(id)
  }
})

function brainDir(home = os.homedir()) {
  return path.join(home, ".gemini", "antigravity-cli", "brain")
}

function transcriptPath(conversationID: string, home = os.homedir()) {
  if (!NATIVE_ID.test(conversationID)) throw new Error("Invalid Antigravity conversation ID")
  return path.join(brainDir(home), conversationID, ".system_generated", "logs", "transcript_full.jsonl")
}

async function conversationIDs(home = os.homedir()) {
  const entries = await fs.readdir(brainDir(home), { withFileTypes: true }).catch(() => [])
  return new Set(entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name))
}

/**
 * Bind only to a directory created by this launch whose transcript contains
 * this prompt. Picking the globally newest directory can attach another AGY
 * process's private conversation to this CodeGoblin session.
 */
async function conversationForPrompt(before: Set<string>, prompt: string, home = os.homedir()) {
  const ids = await conversationIDs(home)
  const candidates = [...ids].filter((id) => !before.has(id) && NATIVE_ID.test(id)).slice(0, 100)
  const needle = normalizePrompt(prompt)
  for (const id of candidates) {
    const handle = await fs.open(transcriptPath(id, home), "r").catch(() => undefined)
    if (!handle) continue
    const buffer = Buffer.alloc(1_048_576)
    const value = await handle
      .read(buffer, 0, buffer.length, 0)
      .then((result) => buffer.subarray(0, result.bytesRead).toString("utf8"))
      .catch(() => "")
    await handle.close().catch(() => {})
    if (normalizePrompt(promptFromTranscript(value)).includes(needle)) return id
  }
}

function promptFromTranscript(value: string) {
  const first = value.split(/\r?\n/).find((line) => line.trim().startsWith("{"))
  if (!first) return ""
  try {
    const record = JSON.parse(first) as { type?: string; content?: string }
    return record.type === "USER_INPUT" ? (record.content ?? "") : ""
  } catch {
    return ""
  }
}

function normalizePrompt(value: string) {
  const request = value.match(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/)?.[1] ?? value
  return request
    .split("<system-reminder>")[0]
    .replace(/^User:\s*/i, "")
    .replace(/^["']|["']$/g, "")
    .replace(/\s+/g, " ")
    .trim()
}

export function antigravityPromptArgument(prompt: string) {
  return `--prompt-interactive=${prompt}`
}

export function antigravityActivityFrom(record: Record<string, unknown>): string | undefined {
  if (record.type === "USER_INPUT" && record.status === "DONE") return "Antigravity received the prompt"
  if (record.type === "CONVERSATION_HISTORY" && record.status === "DONE") return "Antigravity prepared the context"
  if (record.type !== "PLANNER_RESPONSE") return undefined
  const calls = record.tool_calls
  if (!Array.isArray(calls) || !calls.length) return undefined
  const described = calls
    .map((call) => {
      const args = (call as { args?: Record<string, unknown> })?.args ?? {}
      const action = typeof args.toolAction === "string" ? args.toolAction.trim() : ""
      const name = typeof (call as { name?: string })?.name === "string" ? (call as { name: string }).name : ""
      return action || name.replace(/_/g, " ")
    })
    .filter(Boolean)
  return described.length ? described.join(" · ") : undefined
}

export function antigravityAnswerFrom(record: Record<string, unknown>): string | undefined {
  if (record.type !== "PLANNER_RESPONSE") return undefined
  if (Array.isArray(record.tool_calls) && record.tool_calls.length) return undefined
  const content = typeof record.content === "string" ? record.content.trim() : ""
  return content || undefined
}

function stop(sessionID: string) {
  const session = sessions.get(sessionID)
  if (!session) return
  sessions.delete(sessionID)
  try {
    session.proc.kill()
  } catch {}
}

export function stopAntigravitySession(sessionID: string) {
  stop(sessionID)
}

export function stopAllAntigravitySessions() {
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

async function startSession(input: AntigravitySendInput): Promise<Session> {
  const { spawn } = await pty()
  const before = input.conversationID ? new Set<string>() : await conversationIDs()
  const transcript = input.conversationID ? transcriptPath(input.conversationID) : undefined
  const offset = transcript ? ((await fs.stat(transcript).catch(() => undefined))?.size ?? 0) : 0
  const proc = spawn(
    input.executable,
    [
      antigravityPromptArgument(input.prompt),
      ...(input.conversationID ? ["--conversation", input.conversationID] : []),
      ...(input.modelID === "default" ? [] : ["--model", input.modelID]),
      "--mode",
      input.permissionMode === "plan" ? "plan" : "accept-edits",
    ],
    { name: "xterm-256color", cols: 140, rows: 45, cwd: input.cwd, env: process.env as Record<string, string> },
  )
  const session: Session = {
    proc,
    cwd: input.cwd,
    modelID: input.modelID,
    permissionMode: input.permissionMode,
    conversationID: input.conversationID,
    transcript,
    offset,
    partial: "",
    lastUsed: Date.now(),
    busy: true,
    terminal: "",
  }
  // A dead process must never linger in the map as a warm session.
  proc.onExit(() => {
    if (sessions.get(input.sessionID) === session) sessions.delete(input.sessionID)
  })
  proc.onData((data) => {
    session.terminal = `${session.terminal}${data}`.slice(-4096)
  })
  sessions.set(input.sessionID, session)
  ensureReaper()

  // A new conversation directory appears shortly after launch. Resumed
  // sessions bind directly to the remembered native transcript instead.
  for (let i = 0; i < 60 && !session.conversationID; i++) {
    await new Promise((r) => setTimeout(r, 500))
    const found = await conversationForPrompt(before, input.prompt)
    if (found) {
      session.conversationID = found
      session.transcript = transcriptPath(found)
    }
  }
  return session
}

/** Read transcript records appended since the last read. */
async function readNew(session: Session) {
  if (!session.transcript) return []
  const handle = await fs.open(session.transcript, "r").catch(() => undefined)
  if (!handle) return []
  try {
    const stat = await handle.stat()
    if (stat.size <= session.offset) return []
    const length = Math.min(stat.size - session.offset, MAX_TRANSCRIPT_READ)
    const buffer = Buffer.alloc(length)
    const { bytesRead } = await handle.read(buffer, 0, length, session.offset)
    session.offset += bytesRead
    const lines = `${session.partial}${buffer.subarray(0, bytesRead).toString("utf8")}`.split(/\r?\n/)
    session.partial = lines.pop() ?? ""
    if (session.partial.length > MAX_TRANSCRIPT_PARTIAL) session.partial = ""
    return lines
      .flatMap((line) => {
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

/**
 * Send a prompt to this session's warm Antigravity process, reporting real tool
 * steps as they land, and resolve with the assistant's answer.
 */
export async function sendToAntigravitySession(
  input: AntigravitySendInput,
): Promise<{ text: string; conversationID?: string } | undefined> {
  const quiet = input.answerQuietMs ?? 1000
  const timeout = input.timeoutMs ?? 300_000

  let session = sessions.get(input.sessionID)
  // A different model or directory needs its own process; reuse would silently
  // answer with the wrong model.
  if (
    session &&
    (session.modelID !== input.modelID ||
      session.cwd !== input.cwd ||
      session.permissionMode !== input.permissionMode ||
      (input.conversationID !== undefined && session.conversationID !== input.conversationID))
  ) {
    stop(input.sessionID)
    session = undefined
  }
  if (session?.busy) return undefined

  if (!session) {
    session = await startSession(input).catch(() => undefined)
    if (!session?.conversationID) {
      if (session) stop(input.sessionID)
      return undefined
    }
  } else {
    session.busy = true
    // The footer still reads idle from the previous turn; clear it so this
    // turn cannot complete against a stale "prompt ready".
    session.terminal = ""
    // Typing into the live prompt is what keeps the process warm.
    session.proc.write(`\x1b[200~${ptyPaste(input.prompt)}\x1b[201~`)
    await new Promise((r) => setTimeout(r, 750))
    session.proc.write("\r")
  }

  const abort = () => stop(input.sessionID)
  input.signal?.addEventListener("abort", abort, { once: true })

  const startedAt = Date.now()
  let answer: string | undefined
  let lastRecordAt = Date.now()
  let complete = false
  try {
    while (Date.now() - startedAt < timeout) {
      if (input.signal?.aborted) return undefined
      if (!sessions.has(input.sessionID)) return undefined
      const records = await readNew(session)
      for (const record of records) {
        lastRecordAt = Date.now()
        const activity = antigravityActivityFrom(record)
        if (activity) input.onActivity?.(activity)
        const text = antigravityAnswerFrom(record)
        if (text) answer = text
        if (answer && record.type === "CHECKPOINT") complete = true
      }
      // An idle footer means AGY has finished this turn. Ordering matters: the
      // terminal goes idle *before* the answer reaches the transcript we poll,
      // so this must be a state test, not "did idle arrive after the answer" —
      // that can never be true and always fell through to the timer below.
      if (answer && antigravityIdle(session.terminal)) complete = true
      // The checkpoint or idle footer is authoritative. The quiet fallback only
      // covers terminals that expose neither.
      if (complete || (answer && Date.now() - lastRecordAt > Math.max(quiet, 8000))) break
      await new Promise((r) => setTimeout(r, 150))
    }
  } finally {
    input.signal?.removeEventListener("abort", abort)
    const current = sessions.get(input.sessionID)
    if (current) {
      current.busy = false
      current.lastUsed = Date.now()
    }
  }

  if (!answer) {
    // A timed-out process can still emit into the next turn. Never keep it.
    stop(input.sessionID)
    return undefined
  }
  return { text: answer, conversationID: session.conversationID }
}
