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
        record("session_meta", { id: "codex-12345678", cwd: "C:/repo" }),
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
        record("response_item", { type: "function_call", name: "shell" }),
        record("response_item", {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Done" }],
        }),
      ].join("\n"),
    )

    const sessions = await discoverExternalSessions({ home: home.path })
    expect(sessions).toHaveLength(1)
    expect(sessions[0]).toMatchObject({ source: "codex", title: "Fix login", directory: "C:/repo" })
    expect((await loadExternalSession(sessions[0])).messages).toEqual([
      { role: "user", text: "Fix login", time: undefined },
      { role: "assistant", text: "Done", time: undefined },
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
            content: [
              { type: "text", text: "Added them" },
              { type: "tool_use", name: "Edit", input: { secret: "not imported" } },
            ],
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
    expect((await loadExternalSession(sessions[0])).messages.map((message) => message.text)).toEqual([
      "Add tests",
      "Added them",
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
