import { describe, expect, test } from "bun:test"
import {
  buildCliAgentCommand,
  cliAgentProviderInfos,
  cursorAgentCandidates,
  cliAgentResumeCommand,
  deterministicCliSessionID,
  parseClaudeQuota,
  parseCliAgentEvent,
} from "../../src/provider/cli-agent"
import { withoutRetiredAnthropicOauth } from "../../src/auth"
import {
  AnthropicCliAuthPlugin,
  AntigravityCliAuthPlugin,
  CursorAgentCliAuthPlugin,
  installCommand,
} from "../../src/plugin/cli-agent"

describe("local CLI agent providers", () => {
  test("advertises Claude Code and Cursor Agent as local providers", () => {
    const providers = cliAgentProviderInfos()
    expect(providers.map((provider) => String(provider.id))).toEqual(["claude-code", "cursor-agent", "antigravity-cli"])
    expect(providers[0].models.sonnet.name).toBe("Claude Sonnet 5 (alias)")
    expect(providers[0].models.opus.name).toBe("Claude Opus 4.8 (alias)")
    expect(Object.keys(providers[0].models.sonnet.variants ?? {})).toEqual(["low", "medium", "high", "xhigh", "max"])
  })

  test("uses the exact model labels reported by Antigravity", () => {
    const provider = cliAgentProviderInfos({
      "antigravity-cli": [
        { id: "Gemini 3.5 Flash (High)", name: "Gemini 3.5 Flash (High)" },
        { id: "Claude Opus 4.6 (Thinking)", name: "Claude Opus 4.6 (Thinking)" },
      ],
    })[2]
    expect(Object.keys(provider.models)).toEqual(["Gemini 3.5 Flash (High)", "Claude Opus 4.6 (Thinking)"])
  })

  test("connects local CLIs through provider auth methods instead of API-key prompts", async () => {
    const claude = await AnthropicCliAuthPlugin({} as never)
    const cursor = await CursorAgentCliAuthPlugin({} as never)
    const antigravity = await AntigravityCliAuthPlugin({} as never)
    expect(claude.auth?.provider).toBe("anthropic")
    expect(claude.auth?.methods).toEqual([
      expect.objectContaining({ type: "api", label: "API key" }),
      expect.objectContaining({
        type: "oauth",
        provider: "claude-code",
        label: "Claude Code CLI (subscription)",
        prompts: [
          expect.objectContaining({
            key: "setup",
            options: [expect.objectContaining({ value: "installed" }), expect.objectContaining({ value: "install" })],
          }),
        ],
      }),
    ])
    expect(cursor.auth?.methods).toEqual([expect.objectContaining({ type: "oauth", provider: "cursor-agent" })])
    expect(antigravity.auth?.methods).toEqual([expect.objectContaining({ type: "oauth", provider: "antigravity-cli" })])
  })

  test("uses official installers for missing local CLIs", () => {
    expect(installCommand("claude-code", "win32")).toContain("irm https://claude.ai/install.ps1 | iex")
    expect(installCommand("cursor-agent", "win32")).toContain("irm 'https://cursor.com/install?win32=true' | iex")
    expect(installCommand("antigravity-cli", "linux")).toContain(
      "curl -fsSL https://antigravity.google/cli/install.sh | bash",
    )
  })

  test("recognizes Cursor's Windows launchers and versioned install locations", () => {
    expect(cursorAgentCandidates({ LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local" }, "win32")).toEqual([
      "C:\\Users\\test\\AppData\\Local\\cursor-agent\\cursor-agent.exe",
      "C:\\Users\\test\\AppData\\Local\\cursor-agent\\cursor-agent.cmd",
      "C:\\Users\\test\\AppData\\Local\\cursor-agent\\cursor-agent.ps1",
      "C:\\Users\\test\\AppData\\Local\\cursor-agent\\agent.exe",
      "C:\\Users\\test\\AppData\\Local\\cursor-agent\\agent.cmd",
      "C:\\Users\\test\\AppData\\Local\\cursor-agent\\agent.ps1",
      "C:\\Users\\test\\AppData\\Local\\cursor-agent\\versions\\current\\cursor-agent.exe",
      "C:\\Users\\test\\AppData\\Local\\cursor-agent\\versions\\current\\cursor-agent.cmd",
      "C:\\Users\\test\\AppData\\Local\\cursor-agent\\versions\\current\\cursor-agent.ps1",
      "C:\\Users\\test\\AppData\\Local\\cursor-agent\\versions\\current\\agent.exe",
      "C:\\Users\\test\\AppData\\Local\\cursor-agent\\versions\\current\\agent.cmd",
      "C:\\Users\\test\\AppData\\Local\\cursor-agent\\versions\\current\\agent.ps1",
    ])
    expect(cursorAgentCandidates({ LOCALAPPDATA: "C:\\Users\\test" }, "linux")).toEqual([])
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

  test("can fork a Claude-backed chat without overwriting its prior external session", () => {
    const command = buildCliAgentCommand({
      providerID: "claude-code",
      executable: "claude",
      modelID: "sonnet",
      sessionID: "ses_example",
      newSessionID: "11111111-1111-4111-8111-111111111111",
      permissionMode: "agent",
    })
    expect(command).toContain("--session-id")
    expect(command).toContain("11111111-1111-4111-8111-111111111111")
    expect(command).not.toContain("--resume")
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

  test("resumes Antigravity conversations and captures a per-turn log", () => {
    const command = buildCliAgentCommand({
      providerID: "antigravity-cli",
      executable: "agy",
      modelID: "default",
      externalSessionID: "agy-conversation-id",
      sessionID: "ses_example",
      permissionMode: "agent",
      logFile: "agy.log",
    })
    expect(command).toEqual([
      "agy",
      "--print",
      "--log-file",
      "agy.log",
      "--mode",
      "accept-edits",
      "--conversation",
      "agy-conversation-id",
    ])
  })

  test("passes Antigravity's exact model label back to AGY", () => {
    const command = buildCliAgentCommand({
      providerID: "antigravity-cli",
      executable: "agy",
      modelID: "Gemini 3.5 Flash (High)",
      sessionID: "ses_example",
      permissionMode: "agent",
    })
    expect(command).toContain("--model")
    expect(command).toContain("Gemini 3.5 Flash (High)")
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

  test("keeps only sanitized Claude subscription quota fields", () => {
    expect(
      parseClaudeQuota({
        account: { email: "private@example.com" },
        result:
          "Current 5-hour: 50% used\nCurrent week (all models): 20% used · resets Jul 20, 9am\nCurrent week (Fable): 91% used",
      }),
    ).toMatchObject({
      providerID: "claude-code",
      windows: [
        { label: "5h", usedPercentage: 50 },
        { label: "week", usedPercentage: 20, resetsAt: "Jul 20, 9am" },
      ],
    })
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

  test("keeps native resume commands provider-specific", () => {
    expect(cliAgentResumeCommand("claude-code", "claude", "claude-id")).toEqual(["claude", "--resume", "claude-id"])
    expect(cliAgentResumeCommand("cursor-agent", "cursor-agent", "cursor-id")).toEqual([
      "cursor-agent",
      "resume",
      "cursor-id",
    ])
    expect(cliAgentResumeCommand("antigravity-cli", "agy", "agy-id")).toEqual(["agy", "--conversation", "agy-id"])
  })

  test("normalizes Antigravity JSONL without leaking tools or system records", () => {
    expect(
      parseCliAgentEvent(
        "antigravity-cli",
        JSON.stringify({ source: "USER_EXPLICIT", type: "USER_INPUT", content: "hello" }),
      ),
    ).toEqual({ role: "user", text: "hello" })
    expect(
      parseCliAgentEvent(
        "antigravity-cli",
        JSON.stringify({ source: "MODEL", type: "PLANNER_RESPONSE", content: "done", thinking: "plan" }),
      ),
    ).toEqual({ role: "assistant", text: "done", reasoning: "plan" })
    expect(parseCliAgentEvent("antigravity-cli", JSON.stringify({ source: "TOOL", type: "LIST_DIRECTORY" }))).toEqual(
      {},
    )
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
