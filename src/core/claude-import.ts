import fs from "node:fs/promises"
import path from "node:path"
import { Global } from "../platform/paths"
import * as sessions from "./sessions"
import type { Message } from "./agent"

/**
 * Claude Code conversations, copied in as text.
 *
 * Read through the official Agent SDK's session readers (listSessions,
 * getSessionMessages, getSessionInfo) rather than by parsing
 * ~/.claude/projects ourselves: how those files are laid out is the SDK's to
 * change. Only the readers are loaded, never query(), so the SDK's peers and
 * its bundled Claude binary are not needed - see bunfig.toml.
 *
 * Like /import codex: this project's conversations only, a new session with
 * provenance, the source untouched, and only what was said - no tool calls or
 * results, no thinking, no subagent turns, and none of the text Claude Code
 * injects into the user's side (reminders, command wrappers, notifications).
 */

export type ClaudeSessionInfo = { sessionId: string; summary?: string; customTitle?: string; lastModified?: number; cwd?: string; fileSize?: number }
export type ClaudeSessionMessage = { type: string; message?: unknown; parent_tool_use_id?: string | null }
export type Readers = {
  listSessions(options: { dir: string; limit?: number; includeWorktrees?: boolean }): Promise<ClaudeSessionInfo[]>
  getSessionInfo(id: string, options: { dir: string }): Promise<ClaudeSessionInfo | undefined>
  getSessionMessages(id: string, options: { dir: string; limit?: number; offset?: number }): Promise<ClaudeSessionMessage[]>
}

// Loaded only when an import is asked for: the SDK is not needed to start CG-Next.
const sdk = async () => (await import("@anthropic-ai/claude-agent-sdk")) as unknown as Readers

const idOf = (value: string) => {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw new Error("Invalid Claude Code session ID")
  return value
}
const sameProject = (a: string, b: string) => process.platform === "win32"
  ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
  : path.resolve(a) === path.resolve(b)
const label = (value: unknown) => typeof value === "string" && value.trim() ? value.replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 100) : "Claude Code conversation"
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}

const PAGE = 20

export async function listClaudeSessions(root: string, cursor?: string, readers?: Readers) {
  const offset = cursor && /^\d{1,6}$/.test(cursor) ? Number(cursor) : 0
  const found = await (readers ?? await sdk()).listSessions({ dir: path.resolve(root), includeWorktrees: false })
  const mine = found.filter((entry) => typeof entry.sessionId === "string" && (!entry.cwd || sameProject(entry.cwd, root)))
  return {
    sessions: mine.slice(offset, offset + PAGE).flatMap((entry) => {
      try {
        return [{ id: idOf(entry.sessionId), title: label(entry.customTitle || entry.summary),
          updatedAt: typeof entry.lastModified === "number" && entry.lastModified >= 0 ? Math.floor(entry.lastModified / 1000) : undefined }]
      } catch { return [] }
    }),
    next: mine.length > offset + PAGE ? String(offset + PAGE) : undefined,
  }
}

/**
 * Wrappers Claude Code puts on the user's side of the transcript. A block that
 * is one of these is the harness talking, not the person.
 */
const INJECTED = /^\s*<(system-reminder|command-name|command-message|command-args|command-contents|local-command-stdout|local-command-stderr|local-command-caveat|task-notification|user-prompt-submit-hook|bash-input|bash-stdout|bash-stderr|ide_selection|ide_opened_file)>/
const INTERRUPTED = /^\s*\[Request interrupted by user/

function userText(content: unknown): string {
  const blocks = typeof content === "string" ? [content] : Array.isArray(content)
    ? content.map(object).filter((block) => block.type === "text" && typeof block.text === "string").map((block) => String(block.text))
    : []
  return blocks
    // Reminders can also ride inside a typed prompt; cut them out, keep the rest.
    .map((text) => text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim())
    .filter((text) => text && !INJECTED.test(text) && !INTERRUPTED.test(text))
    .join("\n")
}

function assistantText(content: unknown): string {
  if (typeof content === "string") return content.trim()
  if (!Array.isArray(content)) return ""
  return content.map(object).filter((block) => block.type === "text" && typeof block.text === "string").map((block) => String(block.text).trim()).filter(Boolean).join("\n\n")
}

/** Text transcript only, in order. A reply split across several entries becomes one message again. */
export function transcriptMessages(entries: ClaudeSessionMessage[]): Message[] {
  const messages: Message[] = []
  for (const entry of entries) {
    if (entry.parent_tool_use_id) continue
    const payload = object(entry.message)
    const text = entry.type === "user" ? userText(payload.content) : entry.type === "assistant" ? assistantText(payload.content) : ""
    if (!text) continue
    const role = entry.type === "user" ? "user" as const : "assistant" as const
    const last = messages.at(-1)
    if (last && last.role === role) last.content += "\n\n" + text
    else messages.push({ role, content: text })
  }
  return messages
}

const MAX_IMPORT_MESSAGES = 50_000
const MAX_IMPORT_BYTES = 128 * 1024 * 1024
const MESSAGE_PAGE = 1000
const MAX_ENTRIES = 500_000

export async function importClaudeSession(id: string, root: string, provider: string, readers?: Readers) {
  idOf(id)
  const read = readers ?? await sdk()
  const dir = path.resolve(root)
  const info = await read.getSessionInfo(id, { dir })
  if (!info || info.sessionId !== id) throw new Error("Claude Code conversation not found for this project")
  if (info.cwd && !sameProject(info.cwd, root)) throw new Error("Claude Code conversation does not belong to this project")
  const entries: ClaudeSessionMessage[] = []
  for (let offset = 0; offset < MAX_ENTRIES; offset += MESSAGE_PAGE) {
    const page = await read.getSessionMessages(id, { dir, limit: MESSAGE_PAGE, offset })
    entries.push(...page)
    if (page.length < MESSAGE_PAGE) break
  }
  const messages = transcriptMessages(entries)
  if (!messages.length) throw new Error("No text messages to import")
  if (messages.length > MAX_IMPORT_MESSAGES || JSON.stringify(messages).length > MAX_IMPORT_BYTES) throw new Error("Conversation is too large to import safely")
  const session: sessions.Session = {
    ...sessions.create(provider), id: crypto.randomUUID(), title: "Imported: " + label(info.customTitle || info.summary || sessions.titleFrom(messages)),
    messages, importedFrom: { provider: "claude-code", id, importedAt: Date.now() },
  }
  const store = path.join(Global.Path.state, "sessions")
  await fs.mkdir(store, { recursive: true })
  // Exclusive create, even on an improbable UUID collision. Never overwrite an existing session.
  await fs.writeFile(path.join(store, session.id + ".json"), JSON.stringify(session, null, 2), { flag: "wx", mode: 0o600 })
  return { id: session.id, title: session.title, messages: session.messages.length }
}
