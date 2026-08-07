import { describe, expect, test } from "bun:test"
import {
  buildCliAgentCommand,
  cliAgentProviderInfos,
  cursorAgentCandidates,
  claudeAgentCandidates,
  cliAgentResumeCommand,
  deterministicCliSessionID,
  parseClaudeQuota,
  parseCliAgentEvent,
  parseAntigravityModelLines,
  parseCursorModelLines,
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
    expect(providers[0].name).toBe("Claude Code CLI")
    expect(providers[0].models.sonnet.name).toBe("Sonnet 5")
    expect(providers[0].models.opus.name).toBe("Opus 4.8")
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

  test("parses Cursor model IDs separately from display names", () => {
    expect(
      parseCursorModelLines(
        `Available models:\n  auto - Auto (current, default)\n  gpt-5.3-codex-low - Codex 5.3 Low (current)\nTip: use --model <id>`,
      ),
    ).toEqual([
      { id: "auto", name: "Auto (Cursor default)" },
      { id: "gpt-5.3-codex-low", name: "Codex 5.3 Low" },
    ])
  })

  test("pretty-prints Antigravity model IDs while preserving exact IDs", () => {
    expect(
      parseAntigravityModelLines("gemini-3.5-flash-medium\nclaude-opus-4-6-thinking\ngpt-oss-120b-medium"),
    ).toEqual([
      { id: "gemini-3.5-flash-medium", name: "Gemini 3.5 Flash (Medium)" },
      { id: "claude-opus-4-6-thinking", name: "Claude Opus 4.6 (Thinking)" },
      { id: "gpt-oss-120b-medium", name: "GPT OSS 120B (Medium)" },
    ])
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
      title: "CodeGoblin test chat",
    })
    expect(command).toContain("--session-id")
    expect(command).toContain("11111111-1111-4111-8111-111111111111")
    expect(command).toContain("--name")
    expect(command).toContain("CodeGoblin test chat")
    expect(command).not.toContain("--resume")
  })

  test("does not rename an existing Claude session when resuming it", () => {
    const command = buildCliAgentCommand({
      providerID: "claude-code",
      executable: "claude",
      modelID: "sonnet",
      externalSessionID: "11111111-1111-4111-8111-111111111111",
      sessionID: "ses_example",
      permissionMode: "agent",
      title: "Ignored on resume",
    })
    expect(command).toContain("--resume")
    expect(command).not.toContain("--name")
  })

  test("resumes Cursor sessions without force mode or implicit workspace trust", () => {
    const command = buildCliAgentCommand({
      providerID: "cursor-agent",
      executable: "cursor-agent",
      modelID: "default",
      externalSessionID: "cursor-chat-id",
      sessionID: "ses_example",
      permissionMode: "agent",
    })
    expect(command).toContain("--resume=cursor-chat-id")
    expect(command).not.toContain("--trust")
    expect(command).not.toContain("--force")

    expect(
      buildCliAgentCommand({
        providerID: "cursor-agent",
        executable: "cursor-agent",
        modelID: "default",
        sessionID: "ses_example",
        permissionMode: "agent",
        trustWorkspace: true,
      }),
    ).toContain("--trust")
  })

  test("recognizes Claude's official user-local install location", () => {
    // Both branches are asserted from whichever machine runs this: separators
    // must follow the platform being described, not the host. Only the win32
    // case was covered before, so building these with the host's `path.join`
    // passed locally on Windows and failed CI on Linux.
    expect(claudeAgentCandidates({ USERPROFILE: "C:\\Users\\test" }, "win32")).toEqual([
      "C:\\Users\\test\\.local\\bin\\claude.exe",
      "C:\\Users\\test\\.local\\bin\\claude.cmd",
      "C:\\Users\\test\\.local\\bin\\claude.ps1",
    ])
    expect(claudeAgentCandidates({ HOME: "/home/test" }, "linux")).toEqual(["/home/test/.local/bin/claude"])
    expect(claudeAgentCandidates({ HOME: "/Users/test" }, "darwin")).toEqual(["/Users/test/.local/bin/claude"])
    // The other platform's variable is not a substitute for the missing one.
    expect(claudeAgentCandidates({ HOME: "/home/test" }, "win32")).toEqual([])
    expect(claudeAgentCandidates({ USERPROFILE: "C:\\Users\\test" }, "linux")).toEqual([])
  })

  test("sends Antigravity prompts as the print argument instead of stdin", () => {
    const command = buildCliAgentCommand({
      providerID: "antigravity-cli",
      executable: "agy",
      modelID: "gemini-3.5-flash-medium",
      sessionID: "ses_example",
      permissionMode: "agent",
      prompt: "hi",
      streamJson: true,
    })
    expect(command.slice(0, 2)).toEqual(["agy", "--print=hi"])
    expect(command).toContain("--print=hi")
    expect(command).not.toContain("--prompt")
    // Without this AGY buffers everything until the run ends, which is what
    // made a turn look frozen; the typed stream reports progress as it goes.
    expect(command.join(" ")).toContain("--output-format stream-json")
  })

  test("still understands pre-1.1.8 Antigravity records", () => {
    // Older installs have no --output-format, so the CLI emits plain
    // source/type records. Those must keep working, not yield empty replies.
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
    expect(parseCliAgentEvent("antigravity-cli", JSON.stringify({ source: "TOOL", type: "LIST_DIRECTORY" }))).toEqual({})
  })

  test("omits --output-format when the installed Antigravity cannot stream", () => {
    const legacy = buildCliAgentCommand({
      providerID: "antigravity-cli",
      executable: "agy",
      modelID: "default",
      sessionID: "ses_example",
      permissionMode: "agent",
      prompt: "hi",
      streamJson: false,
    })
    expect(legacy).not.toContain("--output-format")
    expect(legacy.join(" ")).toContain("--print=hi")
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
      streamJson: true,
    })
    expect(command).toEqual([
      "agy",
      "--print",
      "--output-format",
      "stream-json",
      "--conversation",
      "agy-conversation-id",
      "--mode",
      "accept-edits",
      "--log-file",
      "agy.log",
    ])
  })

  test("puts Antigravity model and prompt flags before mode so AGY does not enter help mode", () => {
    const command = buildCliAgentCommand({
      providerID: "antigravity-cli",
      executable: "agy",
      modelID: "gemini-3.5-flash-low",
      sessionID: "session-id",
      permissionMode: "agent",
      prompt: "hi",
      logFile: "C:\\temp\\agy.log",
    })

    expect(command.indexOf("--model")).toBeLessThan(command.indexOf("--mode"))
    expect(command.indexOf("--print=hi")).toBeLessThan(command.indexOf("--mode"))
    expect(command).not.toContain("--prompt")
  })

  test("keeps Antigravity prompts that begin with a dash out of option parsing", () => {
    const command = buildCliAgentCommand({
      providerID: "antigravity-cli",
      executable: "agy",
      modelID: "gemini-3.6-flash-low",
      sessionID: "session-id",
      permissionMode: "agent",
      prompt: "--log-file",
    })
    expect(command).toContain("--print=--log-file")
    expect(command.filter((item) => item === "--log-file")).toEqual([])
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
    expect(result?.usage?.inputTokens).toEqual({ total: 17, noCache: 12, cacheRead: 5, cacheWrite: undefined })
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

  test("accepts Claude's current-session quota wording", () => {
    expect(
      parseClaudeQuota({
        result: "Current session: 3% used · resets Jul 23, 4:29am (America/New_York)\nCurrent week (all models): 38% used",
      }),
    ).toMatchObject({
      providerID: "claude-code",
      windows: [
        { label: "5h", usedPercentage: 3, resetsAt: "Jul 23, 4:29am (America/New_York)" },
        { label: "week", usedPercentage: 38 },
      ],
    })
  })

  test("deduplicates Claude's equivalent session and five-hour quota rows", () => {
    expect(
      parseClaudeQuota({
        result:
          "Current session: 9% used · resets Jul 23, 4:29am\nCurrent 5-hour: 10% used · resets Jul 23, 4:30am\nCurrent week (all models): 38% used",
      }),
    ).toMatchObject({
      windows: [
        { label: "5h", usedPercentage: 10, resetsAt: "Jul 23, 4:30am" },
        { label: "week", usedPercentage: 38 },
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
      "--resume",
      "cursor-id",
    ])
    expect(cliAgentResumeCommand("antigravity-cli", "agy", "agy-id")).toEqual(["agy", "--conversation", "agy-id"])
  })

  test("normalizes the Antigravity event stream without leaking internals", () => {
    // AGY 1.1.8 emits typed NDJSON: init / step_update / result.
    expect(
      parseCliAgentEvent(
        "antigravity-cli",
        JSON.stringify({ event: "init", conversation_id: "agy-1", init: { model: "gemini-3.6-flash-low" } }),
      ),
    ).toEqual({ sessionID: "agy-1" })

    // A tool step reports the real tool, once, when it starts.
    expect(
      parseCliAgentEvent(
        "antigravity-cli",
        JSON.stringify({
          event: "step_update",
          step_update: {
            conversation_id: "agy-1",
            state: "ACTIVE",
            step_type: "tool",
            tool_info: { name: "list_dir", parameters: {} },
          },
        }),
      ),
    ).toEqual({ sessionID: "agy-1", reasoning: "list dir\n" })

    // The DONE echo of the same step must not repeat it.
    expect(
      parseCliAgentEvent(
        "antigravity-cli",
        JSON.stringify({
          event: "step_update",
          step_update: { conversation_id: "agy-1", state: "DONE", step_type: "tool", tool_info: { name: "list_dir" } },
        }),
      ),
    ).toEqual({ sessionID: "agy-1" })

    // Bookkeeping steps carry nothing user-facing.
    for (const step_type of ["checkpoint", "user_input", "unknown"]) {
      expect(
        parseCliAgentEvent(
          "antigravity-cli",
          JSON.stringify({ event: "step_update", step_update: { conversation_id: "agy-1", state: "DONE", step_type } }),
        ),
      ).toEqual({ sessionID: "agy-1" })
    }

    // Assistant text arrives as deltas.
    expect(
      parseCliAgentEvent(
        "antigravity-cli",
        JSON.stringify({
          event: "step_update",
          step_update: { conversation_id: "agy-1", state: "DONE", step_type: "agent_response", text_delta: "hi" },
        }),
      ),
    ).toMatchObject({ sessionID: "agy-1", role: "assistant", text: "hi" })

    // The terminal event carries the answer and real token accounting.
    const result = parseCliAgentEvent(
      "antigravity-cli",
      JSON.stringify({
        event: "result",
        result: {
          conversation_id: "agy-1",
          status: "SUCCESS",
          response: "done",
          usage: { input_tokens: 10, output_tokens: 4, cache_read_tokens: 7, thinking_tokens: 1 },
        },
      }),
    )
    expect(result?.result).toBe("done")
    expect(result?.usage?.inputTokens.cacheRead).toBe(7)
    expect(result?.usage?.outputTokens.total).toBe(4)

    // A failed run surfaces as an error rather than an empty reply.
    expect(
      parseCliAgentEvent(
        "antigravity-cli",
        JSON.stringify({ event: "result", result: { conversation_id: "agy-1", status: "FAILED" } }),
      )?.error,
    ).toContain("failed")
  })
})
