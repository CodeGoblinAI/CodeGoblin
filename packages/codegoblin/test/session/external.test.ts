import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { discoverExternalSessions, loadExternalSession } from "../../src/session/external"

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
