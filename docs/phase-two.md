# Phase 2 checkpoint — September 20, 2026

## First slice: Claude CLI chat connector

Claude Code is selectable as `claude-code/default`, `claude-code/haiku`,
`claude-code/sonnet`, or `claude-code/opus` in the TUI, web picker and one-shot CLI.
Aliases are resolved by the installed official CLI, not pinned model-version guesses.

This is **text-only chat, not a tool-enabled coding connector**. The CLI starts with
`--safe-mode --tools "" --strict-mcp-config --disable-slash-commands` and no session
persistence. It cannot use its native filesystem, shell, MCP or agent tools. CG-Next
also verifies that initialization reports empty tools and MCP servers. Full Access
does not enable Claude's tools. Existing API-provider coding agents are unchanged.

The connector streams text and available thinking deltas, records reported tokens
(including cache tokens), supports stop/cancellation, and bounds runtime/output.
Unsuccessful or incomplete CLI results are errors, not empty successful responses.
CG-Next stores its own conversation; it sends prior conversation text as JSON on
each invocation. Explicit @file context still works through CG-Next. Images are not
sent. CLI chat does not consume CG-Next system instructions, memory, skills indexes,
boost agents or its tool schemas. Large conversations fail clearly instead of being
silently truncated; compaction support remains pending.

Authentication stays with the official CLI. `claude auth status` checks readiness;
only a readiness boolean and generic diagnostic are exposed. No OAuth files are
read or credentials copied. Sign in with `claude auth login` in your terminal.
The web picker and `/status` show CLI setup information. TUI `/status` rechecks login.
The installed CLI's chosen credentials determine subscription vs API billing;
token counts are not presented as a dollar bill or a subscription quota.

Requires a current Claude Code CLI supporting these flags (tested with 2.1.270).
Older unsupported flags fail closed; no unsafe compatibility fallback exists.

```powershell
Set-Location 'C:\Users\shawn\code\CG-Next'
claude auth status
bun src/cli/prompt.ts --model claude-code/haiku "Reply with hello"
bun src/tui/app.ts --model claude-code/haiku
# Or start the web UI and choose Claude CLI (chat only) haiku:
bun src/web/serve.ts
```

## Verification

- Real official CLI smoke response, using the existing signed-in account.
- Real TUI prompt returned `TUI_CLI_OK`; Escape stopped another active request,
  returned to the composer, and left no matching tool-free Claude process running.
- Headed browser: picked Haiku, submitted a prompt, received `WEB_CLI_OK`, returned idle.
- Isolated CG-Next profiles under `output/phase2-*`; existing user sessions untouched.
- 617 tests pass and typecheck is clean. Parser tests cover duplicate result suppression,
  fallback text, cached token counts, output truncation, bad JSON, native-tool refusal,
  missing initialization and pre-cancelled calls. Automated tests do not use subscription quota.
- Live smoke calls used a small amount of the signed-in account's allowance. The CLI
  reported ~89% weekly utilization, so tests were intentionally brief.

## Still pending in Phase 2

- Tool-enabled CLI integration with an explicit approval-ownership bridge.
- Cursor and Codex connectors using their supported protocols.
- Persistent subscription usage/reset displays, with freshness and unavailable states.
- Provider credit balances, separate from session token/spend estimates.
- In-app sign-in handoff; current Claude login is external via its official CLI.
- Explicitly selected session import, without overwriting existing conversations.

Protocol reference: https://code.claude.com/docs/en/headless
Flags reference: https://code.claude.com/docs/en/cli-reference
