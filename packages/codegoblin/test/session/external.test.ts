import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { Database } from "bun:sqlite"
import { discoverExternalSessions, loadExternalSession, parseCursorSessionList } from "../../src/session/external"

describe("external sessions", () => {
  test("discovers metadata and loads only conversational Codex text", async () => {
    using home = await tempdir()
    const file = path.join(home.path, ".codex", "sessions", "2026", "07", "rollout.jsonl")
    await write(
      file,
      [
        record("session_meta", { id: "codex-12345678", cwd: "C:/repo", model_provider: "openai" }),
        record("response_item", {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "# AGENTS.md instructions for C:/repo\nDo internal setup" }],
        }),
        record("response_item", {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Fix login" }],
        }),
        record("response_item", {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "<turn_aborted>internal interruption state</turn_aborted>" }],
        }),
        record("response_item", {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Fix login" }],
        }),
        record("turn_context", { model: "gpt-5.6-luna" }),
        record("response_item", {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "I’ll inspect it." }],
        }),
        record("response_item", { type: "function_call", name: "shell" }),
        record("response_item", { type: "function_call_output", output: "private tool output" }),
        record("response_item", {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Done" }],
        }),
        record("response_item", {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Double-check it" }],
        }),
        record("turn_context", { model: "gpt-5.7-sol" }),
        record("response_item", {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "It is correct." }],
        }),
      ].join("\n"),
    )

    const sessions = await discoverExternalSessions({ home: home.path })
    expect(sessions).toHaveLength(1)
    expect(sessions[0]).toMatchObject({ source: "codex", title: "Fix login", directory: "C:/repo" })
    expect((await loadExternalSession(sessions[0])).messages).toEqual([
      { role: "user", text: "Fix login", time: undefined },
      {
        role: "assistant",
        text: "I’ll inspect it.\n\nDone",
        time: undefined,
        model: { providerID: "openai", id: "gpt-5.6-luna" },
      },
      { role: "user", text: "Double-check it", time: undefined },
      {
        role: "assistant",
        text: "It is correct.",
        time: undefined,
        model: { providerID: "openai", id: "gpt-5.7-sol" },
      },
    ])
  })

  test("discovers Claude Code sessions and ignores subagents and tool blocks", async () => {
    using home = await tempdir()
    const file = path.join(home.path, ".claude", "projects", "repo", "claude-123.jsonl")
    await write(
      file,
      [
        JSON.stringify({
          type: "user",
          sessionId: "claude-123",
          cwd: "C:/repo",
          message: { role: "user", content: "Add tests" },
        }),
        JSON.stringify({
          type: "assistant",
          sessionId: "claude-123",
          message: {
            role: "assistant",
            model: "claude-fable-5",
            content: [
              { type: "thinking", thinking: "Inspect the tests" },
              { type: "text", text: "I’ll inspect the tests." },
              { type: "tool_use", name: "Edit", input: { secret: "not imported" } },
            ],
          },
        }),
        JSON.stringify({
          type: "user",
          sessionId: "claude-123",
          message: { role: "user", content: [{ type: "tool_result", content: "private tool output" }] },
        }),
        JSON.stringify({
          type: "assistant",
          sessionId: "claude-123",
          message: {
            role: "assistant",
            model: "claude-fable-5",
            content: [{ type: "text", text: "Added them." }],
          },
        }),
        JSON.stringify({
          type: "user",
          sessionId: "claude-123",
          isMeta: true,
          message: { role: "user", content: [{ type: "text", text: "Injected skill instructions" }] },
        }),
        JSON.stringify({
          type: "user",
          sessionId: "claude-123",
          message: { role: "user", content: "<task-notification>internal task output</task-notification>" },
        }),
        JSON.stringify({
          type: "user",
          sessionId: "claude-123",
          message: { role: "user", content: "<local-command-stdout>Set model</local-command-stdout>" },
        }),
        JSON.stringify({
          type: "user",
          sessionId: "claude-123",
          message: { role: "user", content: "Anything else?" },
        }),
        JSON.stringify({
          type: "assistant",
          sessionId: "claude-123",
          message: {
            role: "assistant",
            model: "claude-sonnet-5",
            content: [{ type: "text", text: "No, that’s all." }],
          },
        }),
      ].join("\n"),
    )
    await write(
      path.join(home.path, ".claude", "projects", "repo", "subagents", "agent.jsonl"),
      JSON.stringify({ type: "user", sessionId: "agent", message: { role: "user", content: "hidden" } }),
    )

    const sessions = await discoverExternalSessions({ home: home.path })
    expect(sessions).toHaveLength(1)
    expect(sessions[0]).toMatchObject({ source: "claude-code", title: "Add tests", directory: "C:/repo" })
    expect((await loadExternalSession(sessions[0])).messages).toEqual([
      { role: "user", text: "Add tests", time: undefined },
      {
        role: "assistant",
        text: "I’ll inspect the tests.\n\nAdded them.",
        time: undefined,
        model: { providerID: "anthropic", id: "claude-fable-5" },
      },
      { role: "user", text: "Anything else?", time: undefined },
      {
        role: "assistant",
        text: "No, that’s all.",
        time: undefined,
        model: { providerID: "anthropic", id: "claude-sonnet-5" },
      },
    ])
  })

  test("only scans explicitly selected sources", async () => {
    using home = await tempdir()
    await write(
      path.join(home.path, ".claude", "projects", "repo", "claude-123.jsonl"),
      JSON.stringify({ type: "user", sessionId: "claude-123", message: { role: "user", content: "Claude only" } }),
    )
    await write(
      path.join(home.path, ".codex", "sessions", "rollout.jsonl"),
      record("session_meta", { id: "codex-123" }),
    )

    expect(await discoverExternalSessions({ home: home.path, sources: [] })).toEqual([])
    expect(await discoverExternalSessions({ home: home.path, sources: ["claude-code"] })).toMatchObject([
      { source: "claude-code", title: "Claude only" },
    ])
    expect(await discoverExternalSessions({ home: home.path, sources: ["codex"] })).toMatchObject([
      { source: "codex", title: "Codex session codex-12" },
    ])
  })

  test("discovers Antigravity transcripts and keeps model text separate from tool records", async () => {
    using home = await tempdir()
    const file = path.join(
      home.path,
      ".gemini",
      "antigravity-cli",
      "brain",
      "agy-12345678",
      ".system_generated",
      "logs",
      "transcript.jsonl",
    )
    await write(
      file,
      [
        JSON.stringify({ source: "USER_EXPLICIT", type: "USER_INPUT", content: "Inspect the project" }),
        JSON.stringify({ source: "MODEL", type: "PLANNER_RESPONSE", content: "I’ll inspect it.", thinking: "Plan" }),
        JSON.stringify({ source: "TOOL", type: "LIST_DIRECTORY", content: "private tool output" }),
        JSON.stringify({ source: "MODEL", type: "PLANNER_RESPONSE", content: "The project is healthy." }),
      ].join("\n"),
    )

    const sessions = await discoverExternalSessions({ home: home.path, sources: ["antigravity"] })
    expect(sessions).toMatchObject([{ source: "antigravity", title: "Inspect the project" }])
    expect((await loadExternalSession(sessions[0])).messages).toEqual([
      { role: "user", text: "Inspect the project", time: undefined },
      { role: "assistant", text: "I’ll inspect it.\n\nThe project is healthy.", time: undefined },
    ])
  })

  test("normalizes Cursor's native session list output", () => {
    expect(
      parseCursorSessionList(
        JSON.stringify({ id: "cursor-123", title: "Fix the bridge", cwd: "C:/repo", updated_at: "2026-07-20T12:00:00Z" }),
      ),
    ).toEqual([
      {
        id: "cursor-agent:cursor-123",
        source: "cursor-agent",
        path: "cursor-agent://cursor-123",
        nativeSessionID: "cursor-123",
        title: "Fix the bridge",
        directory: "C:/repo",
        updated: Date.parse("2026-07-20T12:00:00Z"),
      },
    ])
  })

  test("loads Cursor's local transcript without sending a mutating resume prompt", async () => {
    using home = await tempdir()
    const file = path.join(home.path, ".cursor", "chats", "workspace", "cursor-123", "store.db")
    await Bun.write(path.join(path.dirname(file), "meta.json"), "{}", { createPath: true })
    const database = new Database(file, { create: true })
    database.run("CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB)")
    const insert = database.prepare("INSERT INTO blobs VALUES (?, ?)")
    insert.run(
      "context",
      new TextEncoder().encode(JSON.stringify({ role: "system", content: "Internal Cursor instructions" })),
    )
    insert.run(
      "user",
      new TextEncoder().encode(
        JSON.stringify({
          role: "user",
          content: [
            { type: "text", text: "<system_reminder>internal</system_reminder>" },
            { type: "text", text: "<user_query>\nFix the bridge\n</user_query>" },
          ],
        }),
      ),
    )
    insert.run(
      "assistant",
      new TextEncoder().encode(
        JSON.stringify({
          role: "assistant",
          content: [
            { type: "reasoning", text: "private reasoning" },
            { type: "text", text: "The bridge is fixed." },
          ],
          providerOptions: { cursor: { modelName: "cursor-grok-4.5-high" } },
        }),
      ),
    )
    insert.finalize()
    database.close()

    const sessions = await discoverExternalSessions({ home: home.path, sources: ["cursor-agent"] })
    expect(sessions).toMatchObject([
      {
        source: "cursor-agent",
        nativeSessionID: "cursor-123",
        title: "Fix the bridge",
        path: file,
      },
    ])
    expect(
      (await loadExternalSession(sessions[0])).messages,
    ).toEqual([
      { role: "user", text: "Fix the bridge", time: undefined },
      {
        role: "assistant",
        text: "The bridge is fixed.",
        time: undefined,
        model: { providerID: "cursor-agent", id: "cursor-grok-4.5-high" },
      },
    ])
  })
})

function record(type: string, payload: unknown) {
  return JSON.stringify({ type, payload })
}

async function write(file: string, content: string) {
  await Bun.write(file, content, { createPath: true })
}

async function tempdir() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "codegoblin-external-session-"))
  return {
    path: directory,
    [Symbol.dispose]() {
      rmSync(directory, { recursive: true, force: true })
    },
  }
}
