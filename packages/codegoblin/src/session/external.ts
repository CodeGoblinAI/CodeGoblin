import os from "node:os"
import path from "node:path"
import { existsSync } from "node:fs"
import { Database } from "bun:sqlite"

export type ExternalSessionSource = "claude-code" | "codex" | "antigravity" | "cursor-agent"

export type ExternalSessionSummary = {
  id: string
  source: ExternalSessionSource
  path: string
  title: string
  directory?: string
  updated: number
  nativeSessionID?: string
}

export type ExternalSessionTranscript = ExternalSessionSummary & {
  messages: ExternalSessionMessage[]
}

export type ExternalSessionMessage = {
  role: "user" | "assistant"
  text: string
  time?: number
  model?: {
    providerID: string
    id: string
  }
}

type ExternalSessionCandidate = {
  source: ExternalSessionSource
  path: string
  updated: number
}

const PREVIEW_BYTES = 128 * 1024
const MAX_TRANSCRIPT_BYTES = 8 * 1024 * 1024
const MAX_DISCOVERY_FILES = 5_000
const MAX_CURSOR_BLOBS = 5_000

export async function discoverExternalSessions(input?: {
  home?: string
  limit?: number
  sources?: ExternalSessionSource[]
}): Promise<ExternalSessionSummary[]> {
  const home = input?.home ?? os.homedir()
  const sources = input?.sources ?? ["claude-code", "codex"]
  const candidates = await Promise.all(sources.map((source) => discoverSource(home, source, input?.limit ?? 60)))
  const recent = (candidates.flat() as Array<ExternalSessionCandidate | ExternalSessionSummary>)
    .toSorted((a, b) => b.updated - a.updated)
    .slice(0, input?.limit ?? 60)

  return (
    await Promise.all(
      recent.map(async (candidate) => {
        if (isExternalSessionSummary(candidate)) return candidate
        return Bun.file(candidate.path)
          .slice(0, PREVIEW_BYTES)
          .text()
          .then((text) => parseSummary(candidate.source, candidate.path, candidate.updated, text))
          .catch(() => undefined)
      }),
    )
  ).filter((item) => item !== undefined)
}

function isExternalSessionSummary(
  candidate: ExternalSessionCandidate | ExternalSessionSummary,
): candidate is ExternalSessionSummary {
  return "id" in candidate && "title" in candidate
}

export async function loadExternalSession(session: ExternalSessionSummary): Promise<ExternalSessionTranscript> {
  if (session.source === "cursor-agent") return loadCursorSession(session)
  const file = Bun.file(session.path)
  if (file.size > MAX_TRANSCRIPT_BYTES) {
    throw new Error(`External transcript exceeds the ${MAX_TRANSCRIPT_BYTES / 1024 / 1024} MB import limit.`)
  }
  const text = await file.text()
  return {
    ...session,
    messages: parseTranscript(session.source, text),
  }
}

async function collect(roots: string[], source: ExternalSessionSource) {
  const glob = new Bun.Glob("**/*.jsonl")
  const files = [] as ExternalSessionCandidate[]
  for (const root of roots) {
    if (!existsSync(root)) continue
    for await (const relative of glob.scan({ cwd: root, absolute: false, onlyFiles: true, dot: true })) {
      if (files.length >= MAX_DISCOVERY_FILES) break
      if (source === "claude-code" && relative.split(/[\\/]/).includes("subagents")) continue
      const file = path.join(root, relative)
      const stat = await Bun.file(file)
        .stat()
        .catch(() => undefined)
      if (!stat) continue
      files.push({ source, path: file, updated: stat.mtimeMs })
    }
  }
  return files
}

async function discoverSource(home: string, source: ExternalSessionSource, limit: number) {
  if (source === "cursor-agent") return discoverCursorSessions(home, limit)
  return collect(
    source === "claude-code"
      ? [path.join(home, ".claude/projects")]
      : source === "codex"
        ? [path.join(home, ".codex/sessions")]
        : [path.join(home, ".gemini/antigravity-cli/brain"), path.join(home, ".gemini/antigravity/brain")],
    source,
  )
}

async function discoverCursorSessions(home: string, limit: number) {
  const root = path.join(home, ".cursor", "chats")
  if (!existsSync(root)) return []
  const sessions = [] as ExternalSessionSummary[]
  let scanned = 0
  for await (const file of new Bun.Glob("*/*/meta.json").scan({
    cwd: root,
    absolute: true,
    onlyFiles: true,
  })) {
    if (scanned++ >= MAX_DISCOVERY_FILES) break
    const metadata = await Bun.file(file)
      .json()
      .then((value) => object(value))
      .catch(() => undefined)
    const id = path.basename(path.dirname(file))
    const store = path.join(path.dirname(file), "store.db")
    if (!metadata || metadata.hasConversation === false || !existsSync(store)) continue
    sessions.push({
      id: `cursor-agent:${id}`,
      source: "cursor-agent",
      path: store,
      nativeSessionID: id,
      title: `Cursor session ${id.slice(0, 8)}`,
      directory: string(metadata.cwd),
      updated: timestamp(metadata.updatedAtMs) ?? timestamp(metadata.createdAtMs) ?? 0,
    })
  }
  return Promise.all(
    sessions
      .toSorted((a, b) => b.updated - a.updated)
      .slice(0, limit)
      .map(async (session) => {
        const messages = await readCursorStore(session.path).catch(() => [])
        return {
          ...session,
          title: truncate(titleCandidate(messages.find((message) => message.role === "user")?.text) ?? session.title),
        }
      }),
  )
}

export function parseCursorSessionList(value: string): ExternalSessionSummary[] {
  const parsed = value
    .split(/\r?\n/)
    .flatMap((line) => {
      try {
        const record = JSON.parse(line) as Record<string, unknown>
        const id = string(record.id) ?? string(record.session_id) ?? string(record.sessionId)
        if (!id) return []
        return [
          {
            id: `cursor-agent:${id}`,
            source: "cursor-agent" as const,
            path: `cursor-agent://${encodeURIComponent(id)}`,
            nativeSessionID: id,
            title: truncate(string(record.title) ?? string(record.name) ?? `Cursor session ${id.slice(0, 8)}`),
            directory: string(record.cwd) ?? string(record.directory),
            updated: timestamp(record.updated_at ?? record.updatedAt ?? record.time) ?? Date.now(),
          },
        ]
      } catch {
        return []
      }
    })
  if (parsed.length) return parsed

  return value
    .split(/\r?\n/)
    .flatMap((line) => {
      const id = /\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/i.exec(line)?.[0]
      if (!id) return []
      const title = line.replace(id, "").replace(/[|·].*$/, "").trim()
      return [
        {
          id: `cursor-agent:${id}`,
          source: "cursor-agent" as const,
          path: `cursor-agent://${encodeURIComponent(id)}`,
          nativeSessionID: id,
          title: truncate(title || `Cursor session ${id.slice(0, 8)}`),
          updated: Date.now(),
        },
      ]
    })
}

async function loadCursorSession(session: ExternalSessionSummary): Promise<ExternalSessionTranscript> {
  const store = session.path.endsWith("store.db")
    ? session.path
    : await findCursorStore(os.homedir(), session.nativeSessionID)
  if (!store) {
    throw new Error(
      "Cursor does not expose read-only transcript export, and this session's local transcript was not found.",
    )
  }
  const messages = await readCursorStore(store)
  if (!messages.length) throw new Error("Cursor Agent returned no conversational messages for this session.")
  return { ...session, messages }
}

async function findCursorStore(home: string, sessionID?: string) {
  if (!sessionID || !/^[0-9A-Za-z_-]+$/.test(sessionID)) return
  const root = path.join(home, ".cursor", "chats")
  if (!existsSync(root)) return
  for await (const file of new Bun.Glob(`*/${sessionID}/store.db`).scan({
    cwd: root,
    absolute: true,
    onlyFiles: true,
  })) {
    return file
  }
}

async function readCursorStore(store: string) {
  if (Bun.file(store).size > MAX_TRANSCRIPT_BYTES) {
    throw new Error(`External transcript exceeds the ${MAX_TRANSCRIPT_BYTES / 1024 / 1024} MB import limit.`)
  }
  const database = new Database(store, { readonly: true })
  const query = database.query("SELECT data FROM blobs ORDER BY rowid LIMIT ?")
  const blobs = query.all(MAX_CURSOR_BLOBS + 1) as Array<{ data: Uint8Array }>
  query.finalize()
  database.close()
  if (blobs.length > MAX_CURSOR_BLOBS) throw new Error("Cursor transcript exceeds the import record limit.")
  return parseCursorTranscript(
    blobs.flatMap((blob) => {
      if (blob.data[0] !== 0x7b) return []
      const record = parseRecord(new TextDecoder().decode(blob.data))
      return record ? [record] : []
    }),
  )
}

function parseCursorTranscript(records: Record<string, unknown>[]) {
  return records
    .flatMap((record) => {
      const message = object(record.message) ?? record
      const role = string(message.role) === "user" ? "user" : string(message.role) === "assistant" ? "assistant" : undefined
      if (!role) return []
      const raw = contentText(message.content ?? message.text)
      const text = role === "user" ? /<user_query>\s*([\s\S]*?)\s*<\/user_query>/.exec(raw)?.[1]?.trim() ?? raw : raw
      if (!text || synthetic(text)) return []
      const modelID = string(object(object(message.providerOptions)?.cursor)?.modelName)
      return [
        {
          role,
          text,
          time: timestamp(record.timestamp),
          ...(role === "assistant" && modelID && { model: { providerID: "cursor-agent", id: modelID } }),
        } satisfies ExternalSessionMessage,
      ]
    })
    .reduce<ExternalSessionMessage[]>((result, message) => {
      const previous = result.at(-1)
      if (previous?.role === message.role && previous.text === message.text) return result
      result.push(message)
      return result
    }, [])
}

function parseSummary(
  source: ExternalSessionSource,
  file: string,
  updated: number,
  text: string,
): ExternalSessionSummary | undefined {
  const records = text
    .split(/\r?\n/)
    .map((line) => parseRecord(line))
    .filter((record): record is Record<string, unknown> => record !== undefined)

  if (source === "codex") {
    const meta = object(records.find((record) => record.type === "session_meta")?.payload)
    const id = string(meta?.id)
    if (!id) return
    const first = records
      .flatMap((record) => parseCodexMessage(record))
      .find((message) => message.role === "user" && titleCandidate(message.text))
    return {
      id: `${source}:${id}`,
      source,
      path: file,
      title: truncate(titleCandidate(first?.text) ?? `Codex session ${id.slice(0, 8)}`),
      directory: string(meta?.cwd),
      updated,
    } satisfies ExternalSessionSummary
  }

  if (source === "antigravity") {
    const record = records.find((item) => string(item.conversationId) || string(item.type)?.toUpperCase() === "USER_INPUT")
    const id = string(record?.conversationId) ?? path.basename(path.dirname(path.dirname(path.dirname(file))))
    if (!id) return
    const first = records.flatMap(parseAntigravityMessage).find((message) => message?.role === "user")
    const workspacePaths = record?.workspacePaths
    return {
      id: `${source}:${id}`,
      source,
      path: file,
      title: truncate(titleCandidate(first?.text) ?? `Antigravity session ${id.slice(0, 8)}`),
      directory: Array.isArray(workspacePaths) ? string(workspacePaths[0]) : undefined,
      updated,
    } satisfies ExternalSessionSummary
  }

  const record = records.find((item) => (item.type === "user" || item.type === "assistant") && string(item.sessionId))
  const id = string(record?.sessionId) ?? path.basename(file, ".jsonl")
  if (!id) return
  const first = records
    .flatMap((item) => parseClaudeMessage(item))
    .find((message) => message.role === "user" && titleCandidate(message.text))
  return {
    id: `${source}:${id}`,
    source,
    path: file,
    title: truncate(titleCandidate(first?.text) ?? `Claude Code session ${id.slice(0, 8)}`),
    directory: string(record?.cwd),
    updated,
  } satisfies ExternalSessionSummary
}

function parseTranscript(source: ExternalSessionSource, text: string) {
  const records = text
    .split(/\r?\n/)
    .map((line) => parseRecord(line))
    .filter((record): record is Record<string, unknown> => record !== undefined)
  if (source === "claude-code") return parseClaudeTranscript(records)
  if (source === "antigravity") return parseAntigravityTranscript(records)

  return parseCodexTranscript(records)
}

function parseClaudeTranscript(records: Record<string, unknown>[]) {
  return records.reduce<ExternalSessionMessage[]>((result, record) => {
    return parseClaudeMessage(record).reduce((turns, message) => {
      const text = message.text.trim()
      if (!text) return turns
      const previous = turns.at(-1)
      if (message.role === "user" || previous?.role !== "assistant") {
        turns.push({ ...message, text })
        return turns
      }

      // Claude records tool use and tool results between assistant text fragments.
      // Keep those fragments in the same native assistant turn until a real user message begins the next one.
      previous.text = `${previous.text}\n\n${text}`
      previous.model ??= message.model
      return turns
    }, result)
  }, [])
}

function parseAntigravityTranscript(records: Record<string, unknown>[]) {
  return records.reduce<ExternalSessionMessage[]>((result, record) => {
    const message = parseAntigravityMessage(record)
    if (!message?.text || synthetic(message.text)) return result
    const previous = result.at(-1)
    if (message.role === "user" || previous?.role !== "assistant") {
      result.push({ ...message, text: message.text.trim() })
      return result
    }
    previous.text = `${previous.text}\n\n${message.text.trim()}`
    previous.model ??= message.model
    return result
  }, [])
}

function parseCodexTranscript(records: Record<string, unknown>[]) {
  const state = { providerID: undefined as string | undefined, modelID: undefined as string | undefined }
  return records.reduce<ExternalSessionMessage[]>((result, record) => {
    if (record.type === "session_meta") {
      state.providerID = string(object(record.payload)?.model_provider) ?? state.providerID
      return result
    }
    if (record.type === "turn_context") {
      state.modelID = string(object(record.payload)?.model) ?? state.modelID
      return result
    }
    return parseCodexMessage(record).reduce((turns, message) => {
      const text = message.text.trim()
      if (!text) return turns
      const normalized =
        message.role === "assistant" && state.providerID && state.modelID
          ? { ...message, text, model: { providerID: state.providerID, id: state.modelID } }
          : { ...message, text }
      const previous = turns.at(-1)
      if (normalized.role === "user" && previous?.role === "user" && previous.text === text) return turns
      if (normalized.role === "user" || previous?.role !== "assistant") {
        turns.push(normalized)
        return turns
      }

      // Codex emits commentary and final response items separately inside one turn.
      // Join only adjacent assistant items; the next response_item user message starts a new turn.
      previous.text = `${previous.text}\n\n${text}`
      previous.model = normalized.model ?? previous.model
      return turns
    }, result)
  }, [])
}

function parseCodexMessage(record: Record<string, unknown>): ExternalSessionMessage[] {
  const payload = record.type === "response_item" ? object(record.payload) : record
  if (payload?.type !== "message") return []
  const role = payload.role === "user" ? "user" : payload.role === "assistant" ? "assistant" : undefined
  if (role !== "user" && role !== "assistant") return []
  const text = contentText(payload.content)
  if (!text || synthetic(text)) return []
  return [{ role, text, time: timestamp(record.timestamp) }]
}

function parseClaudeMessage(record: Record<string, unknown>): ExternalSessionMessage[] {
  if (record.type !== "user" && record.type !== "assistant") return []
  const message = object(record.message)
  const value = message?.role ?? record.type
  const role = value === "user" ? "user" : value === "assistant" ? "assistant" : undefined
  if (role !== "user" && role !== "assistant") return []
  if (role === "user" && record.isMeta === true) return []
  const text = contentText(message?.content)
  if (!text || synthetic(text)) return []
  const modelID = string(message?.model)
  const result: ExternalSessionMessage = { role, text, time: timestamp(record.timestamp) }
  if (role === "assistant" && modelID && modelID !== "<synthetic>") {
    result.model = { providerID: "anthropic", id: modelID }
  }
  return [result]
}

function parseAntigravityMessage(record: Record<string, unknown>): ExternalSessionMessage | undefined {
  const source = string(record.source)
  const type = string(record.type)?.toUpperCase()
  if (source === "USER_EXPLICIT" || type === "USER_INPUT") {
    const text = string(record.content)?.trim()
    if (!text) return
    return { role: "user", text, time: timestamp(record.created_at) }
  }
  if (source !== "MODEL" && type !== "ASSISTANT" && type !== "RESPONSE" && type !== "PLANNER_RESPONSE") return
  const text = string(record.content)?.trim()
  if (!text) return
  const modelID = string(record.model) ?? string(object(record.metadata)?.model)
  return {
    role: "assistant",
    text,
    time: timestamp(record.created_at),
    ...(modelID && { model: { providerID: "antigravity-cli", id: modelID } }),
  }
}

function contentText(value: unknown): string {
  if (typeof value === "string") return value.trim()
  if (Array.isArray(value)) {
    return value
      .flatMap((item) => {
        const block = object(item)
        if (!block) return []
        if (!["text", "input_text", "output_text"].includes(string(block.type) ?? "")) return []
        const text = string(block.text)
        return text ? [text] : []
      })
      .join("\n")
      .trim()
  }
  const objectValue = object(value)
  return string(objectValue?.text)?.trim() ?? ""
}

function titleCandidate(value?: string) {
  const text = value?.trim()
  if (!text || synthetic(text)) return
  return text.replace(/\s+/g, " ")
}

function synthetic(text: string) {
  const value = text.trimStart()
  return [
    "# AGENTS.md instructions for",
    "## Memory\n",
    "Base directory for this skill:",
    "<app-context>",
    "<apps_instructions>",
    "<collaboration_mode>",
    "<environment_context>",
    "<local-command-caveat>",
    "<local-command-stdout>",
    "<permissions instructions>",
    "<plugins_instructions>",
    "<recommended_plugins>",
    "<skills_instructions>",
    "<system-reminder>",
    "<system_reminder>",
    "<task-notification>",
    "<turn_aborted>",
    "<turn_cancelled>",
    "<command-name>",
    "<command-message>",
    "<user_info>",
  ].some((prefix) => value.startsWith(prefix))
}

function truncate(value: string) {
  return value.length > 72 ? `${value.slice(0, 69).trimEnd()}...` : value
}

function parseRecord(line: string) {
  if (!line.trim()) return
  try {
    return object(JSON.parse(line))
  } catch {
    return
  }
}

function object(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return
  return value as Record<string, unknown>
}

function string(value: unknown) {
  return typeof value === "string" ? value : undefined
}

function timestamp(value: unknown) {
  const result = typeof value === "number" ? value : Date.parse(string(value) ?? "")
  return Number.isFinite(result) && result >= 0 ? result : undefined
}
