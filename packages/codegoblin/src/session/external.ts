import os from "node:os"
import path from "node:path"
import { existsSync } from "node:fs"

export type ExternalSessionSource = "claude-code" | "codex"

export type ExternalSessionSummary = {
  id: string
  source: ExternalSessionSource
  path: string
  title: string
  directory?: string
  updated: number
}

export type ExternalSessionTranscript = ExternalSessionSummary & {
  messages: Array<{
    role: "user" | "assistant"
    text: string
    time?: number
  }>
}

const PREVIEW_BYTES = 128 * 1024

export async function discoverExternalSessions(input?: { home?: string; limit?: number }) {
  const home = input?.home ?? os.homedir()
  const candidates = await Promise.all([
    collect(path.join(home, ".claude", "projects"), "claude-code"),
    collect(path.join(home, ".codex", "sessions"), "codex"),
  ])
  const recent = candidates
    .flat()
    .toSorted((a, b) => b.updated - a.updated)
    .slice(0, input?.limit ?? 60)

  return (
    await Promise.all(
      recent.map(async (candidate) =>
        Bun.file(candidate.path)
          .slice(0, PREVIEW_BYTES)
          .text()
          .then((text) => parseSummary(candidate.source, candidate.path, candidate.updated, text))
          .catch(() => undefined),
      ),
    )
  ).filter((item) => item !== undefined)
}

export async function loadExternalSession(session: ExternalSessionSummary): Promise<ExternalSessionTranscript> {
  const text = await Bun.file(session.path).text()
  return {
    ...session,
    messages: text
      .split(/\r?\n/)
      .flatMap((line) => parseMessage(session.source, line))
      .filter((message) => message.text.trim().length > 0),
  }
}

async function collect(root: string, source: ExternalSessionSource) {
  const glob = new Bun.Glob("**/*.jsonl")
  const files = [] as Array<{ source: ExternalSessionSource; path: string; updated: number }>
  if (!existsSync(root)) return files
  for await (const relative of glob.scan({ cwd: root, absolute: false, onlyFiles: true })) {
    if (source === "claude-code" && relative.split(/[\\/]/).includes("subagents")) continue
    const file = path.join(root, relative)
    const stat = await Bun.file(file)
      .stat()
      .catch(() => undefined)
    if (!stat) continue
    files.push({ source, path: file, updated: stat.mtimeMs })
  }
  return files
}

function parseSummary(source: ExternalSessionSource, file: string, updated: number, text: string) {
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

function parseMessage(source: ExternalSessionSource, line: string) {
  const record = parseRecord(line)
  if (!record) return []
  return source === "codex" ? parseCodexMessage(record) : parseClaudeMessage(record)
}

function parseCodexMessage(record: Record<string, unknown>): ExternalSessionTranscript["messages"] {
  const payload = record.type === "response_item" ? object(record.payload) : record
  if (payload?.type !== "message") return []
  const role = payload.role === "user" ? "user" : payload.role === "assistant" ? "assistant" : undefined
  if (role !== "user" && role !== "assistant") return []
  const text = contentText(payload.content)
  if (!text || synthetic(text)) return []
  return [{ role, text, time: timestamp(record.timestamp) }]
}

function parseClaudeMessage(record: Record<string, unknown>): ExternalSessionTranscript["messages"] {
  if (record.type !== "user" && record.type !== "assistant") return []
  const message = object(record.message)
  const value = message?.role ?? record.type
  const role = value === "user" ? "user" : value === "assistant" ? "assistant" : undefined
  if (role !== "user" && role !== "assistant") return []
  const text = contentText(message?.content)
  if (!text || synthetic(text)) return []
  return [{ role, text, time: timestamp(record.timestamp) }]
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
    "<app-context>",
    "<apps_instructions>",
    "<collaboration_mode>",
    "<environment_context>",
    "<local-command-caveat>",
    "<permissions instructions>",
    "<plugins_instructions>",
    "<recommended_plugins>",
    "<skills_instructions>",
    "<system-reminder>",
    "<command-name>",
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
