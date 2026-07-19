import { describe, expect, test } from "bun:test"
import {
  buildCliAgentCommand,
  cliAgentProviderInfos,
  deterministicCliSessionID,
  parseCliAgentEvent,
} from "../../src/provider/cli-agent"
import { withoutRetiredAnthropicOauth } from "../../src/auth"
import { ClaudeCodeCliAuthPlugin, CursorAgentCliAuthPlugin } from "../../src/plugin/cli-agent"

describe("local CLI agent providers", () => {
  test("advertises Claude Code and Cursor Agent as local providers", () => {
    const providers = cliAgentProviderInfos()
    expect(providers.map((provider) => String(provider.id))).toEqual(["claude-code", "cursor-agent"])
    expect(Object.keys(providers[0].models.sonnet.variants ?? {})).toEqual(["low", "medium", "high", "xhigh", "max"])
  })

  test("connects local CLIs through provider auth methods instead of API-key prompts", async () => {
    const claude = await ClaudeCodeCliAuthPlugin({} as never)
    const cursor = await CursorAgentCliAuthPlugin({} as never)
    expect(claude.auth?.methods).toEqual([
      expect.objectContaining({ type: "oauth", label: "Connect installed Claude Code" }),
    ])
    expect(cursor.auth?.methods).toEqual([
      expect.objectContaining({ type: "oauth", label: "Connect installed Cursor Agent" }),
    ])
  })

  test("uses a stable valid UUID for Claude sessions", () => {
    const first = deterministicCliSessionID("ses_example")
    expect(first).toBe(deterministicCliSessionID("ses_example"))
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })

  test("maps CodeGoblin modes without bypassing CLI permissions", () => {
    const command = buildCliAgentCommand({
      providerID: "claude-code",
      executable: "claude",
      modelID: "sonnet",
      sessionID: "ses_example",
      permissionMode: "plan",
      effort: "high",
    })
    expect(command).toContain("plan")
    expect(command).toContain("--session-id")
    expect(command).toContain("--effort")
    expect(command).toContain("high")
    expect(command).not.toContain("--dangerously-skip-permissions")
    expect(command).not.toContain("--allow-dangerously-skip-permissions")
  })

  test("resumes Cursor sessions without force mode", () => {
    const command = buildCliAgentCommand({
      providerID: "cursor-agent",
      executable: "cursor-agent",
      modelID: "default",
      externalSessionID: "cursor-chat-id",
      sessionID: "ses_example",
      permissionMode: "agent",
    })
    expect(command).toContain("--resume=cursor-chat-id")
    expect(command).not.toContain("--force")
  })

  test("parses Claude partial text and usage", () => {
    expect(
      parseCliAgentEvent(
        "claude-code",
        JSON.stringify({
          type: "stream_event",
          session_id: "claude-session",
          event: { type: "content_block_delta", delta: { type: "text_delta", text: "hello" } },
        }),
      ),
    ).toEqual({ sessionID: "claude-session", text: "hello" })

    const result = parseCliAgentEvent(
      "claude-code",
      JSON.stringify({ type: "result", usage: { input_tokens: 12, output_tokens: 3, cache_read_input_tokens: 5 } }),
    )
    expect(result?.usage?.inputTokens).toEqual({ total: 12, noCache: 7, cacheRead: 5, cacheWrite: undefined })
    expect(result?.usage?.outputTokens.total).toBe(3)
  })

  test("parses Cursor assistant messages", () => {
    expect(
      parseCliAgentEvent(
        "cursor-agent",
        JSON.stringify({
          type: "assistant",
          session_id: "cursor-session",
          message: { content: [{ type: "text", text: "done" }] },
        }),
      ),
    ).toEqual({ sessionID: "cursor-session", text: "done" })
  })

  test("retires Anthropic subscription OAuth without removing API keys", () => {
    expect(
      withoutRetiredAnthropicOauth({
        anthropic: { type: "oauth", access: "access", refresh: "refresh", expires: 1 },
        openai: { type: "api", key: "openai-key" },
      }),
    ).toEqual({ openai: { type: "api", key: "openai-key" } })
    expect(withoutRetiredAnthropicOauth({ anthropic: { type: "api", key: "anthropic-key" } })).toEqual({
      anthropic: { type: "api", key: "anthropic-key" },
    })
  })
})
