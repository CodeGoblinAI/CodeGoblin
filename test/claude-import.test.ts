import { expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { Global } from "../src/platform/paths"
import { importClaudeSession, listClaudeSessions, transcriptMessages, type ClaudeSessionMessage, type Readers } from "../src/core/claude-import"
import { runCommand } from "../src/core/commands"
import * as sessions from "../src/core/sessions"

const root = process.cwd()
const ID = "5b3f2c1a-8d4e-4f6b-9a7c-2e1d0f9b8a6c"

/** Entries shaped like the real transcripts the SDK returns. */
const entries: ClaudeSessionMessage[] = [
  { type: "user", message: { role: "user", content: "Rename add to sum in app.js" } },
  { type: "assistant", message: { role: "assistant", content: [{ type: "thinking", thinking: "private reasoning" }] } },
  { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Let me look at the file." }] } },
  { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "app.js" } }] } },
  { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "function add(a, b) {}" }] } },
  { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Renamed it." }] } },
  { type: "user", message: { role: "user", content: "<command-name>/model</command-name>\n<command-args>opus</command-args>" } },
  { type: "user", message: { role: "user", content: "<local-command-stdout>Set model to opus</local-command-stdout>" } },
  { type: "user", message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user for tool use]" }] } },
  { type: "user", message: { role: "user", content: [{ type: "text", text: "<system-reminder>hidden harness text</system-reminder>\nNow add a test" }, { type: "image", source: {} }] } },
  { type: "user", message: { role: "user", content: "<task-notification>background task finished</task-notification>" } },
  { type: "assistant", parent_tool_use_id: "agent-1", message: { role: "assistant", content: [{ type: "text", text: "subagent internals" }] } },
  { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Added test/app.test.js." }] } },
]

const readers = (overrides: Partial<Readers> = {}): Readers => ({
  listSessions: async () => [
    { sessionId: ID, summary: "Rename add to sum", lastModified: 1_793_000_000_000, cwd: root },
    { sessionId: "11111111-2222-4333-8444-555555555555", summary: "Elsewhere", cwd: path.join(root, "..", "other-project") },
    { sessionId: "not-a-uuid", summary: "Bad id", cwd: root },
  ],
  getSessionInfo: async (id) => id === ID ? { sessionId: ID, summary: "Rename add to sum", cwd: root } : undefined,
  getSessionMessages: async (_id, options) => entries.slice(options.offset ?? 0, (options.offset ?? 0) + (options.limit ?? entries.length)),
  ...overrides,
})

test("only what was said survives: no tools, thinking, subagents, wrappers or reminders", () => {
  expect(transcriptMessages(entries)).toEqual([
    { role: "user", content: "Rename add to sum in app.js" },
    { role: "assistant", content: "Let me look at the file.\n\nRenamed it." },
    { role: "user", content: "Now add a test" },
    { role: "assistant", content: "Added test/app.test.js." },
  ])
})

test("lists this project's conversations only, with valid ids, a page at a time", async () => {
  const listed = await listClaudeSessions(root, undefined, readers())
  expect(listed.sessions).toEqual([{ id: ID, title: "Rename add to sum", updatedAt: 1_793_000_000 }])
  expect(listed.next).toBeUndefined()
  const many = await listClaudeSessions(root, undefined, readers({
    listSessions: async () => Array.from({ length: 25 }, (_, index) => ({ sessionId: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`, summary: "s" + index, cwd: root })),
  }))
  expect(many.sessions).toHaveLength(20)
  expect(many.next).toBe("20")
  expect((await listClaudeSessions(root, "20", readers({ listSessions: async () => Array.from({ length: 25 }, (_, index) => ({ sessionId: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`, cwd: root })) }))).sessions).toHaveLength(5)
})

test("a copy is a new session with provenance, read in pages, never overwriting", async () => {
  const offsets: number[] = []
  const result = await importClaudeSession(ID, root, "deepseek", readers({
    getSessionMessages: async (_id, options) => { offsets.push(options.offset ?? 0); return entries.slice(options.offset ?? 0, (options.offset ?? 0) + (options.limit ?? 1)) },
  }))
  expect(result.messages).toBe(4)
  expect(result.title).toBe("Imported: Rename add to sum")
  expect(offsets).toEqual([0])
  const saved = JSON.parse(fs.readFileSync(path.join(Global.Path.state, "sessions", result.id + ".json"), "utf8")) as sessions.Session
  expect(saved.importedFrom).toMatchObject({ provider: "claude-code", id: ID })
  expect(saved.id).not.toBe(ID)
  expect(JSON.stringify(saved)).not.toContain("private reasoning")
  expect(JSON.stringify(saved)).not.toContain("hidden harness text")
})

test("another project's, missing, malformed or empty conversations are refused", async () => {
  await expect(importClaudeSession("not-a-uuid", root, "deepseek", readers())).rejects.toThrow("Invalid Claude Code session ID")
  await expect(importClaudeSession("11111111-2222-4333-8444-555555555555", root, "deepseek", readers())).rejects.toThrow("not found")
  await expect(importClaudeSession(ID, root, "deepseek", readers({ getSessionInfo: async () => ({ sessionId: ID, cwd: path.join(root, "..", "other") }) }))).rejects.toThrow("does not belong")
  await expect(importClaudeSession(ID, root, "deepseek", readers({ getSessionMessages: async () => [entries[3]!, entries[4]!] }))).rejects.toThrow("No text messages")
})

test("/import claude and claude-code parse; anything else explains both sources", () => {
  expect(runCommand("/import claude")).toEqual({ kind: "import", source: "claude", id: undefined })
  expect(runCommand("/import claude-code " + ID)).toEqual({ kind: "import", source: "claude", id: ID })
  expect(runCommand("/import windsurf")).toMatchObject({ kind: "message", text: expect.stringContaining("claude") })
})
