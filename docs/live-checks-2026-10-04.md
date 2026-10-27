# Phase 2 live checks — October 4, 2026

Base: `codex/phase2-hardening` at `6607a15`, pulled with `--ff-only` before work.
Concern branch: `codex/phase2-live-checks`. No PR.

All CG writes use `output/live-check-profile`, never the shared real CG profile.
Requested provider keys are read into child environment variables only; no key
is copied to CG auth.json, logs, source or this report. Browser: actual Web UI
in installed headless Chromium (owner away). TUI: actual Windows PTY at 80×24.

| Live check | Result |
|---|---|
| Cursor API-key route | Official SDK catalog succeeded. Actual Web `/model cursor-api/default` and tiny prompt returned `CURSOR_LIVE_OK`, 9,101 reported input / 100 output tokens. Native tools disabled; CG tools unused. One real inference request consumes the key owner's plan/team allowance; cost and effective context remain unknown. |
| Tripo | Actual Web and TUI `/balance tripo`: ready, 0 available / 0 frozen API credits. Balance GET only; **no generation**. |
| ElevenLabs | Actual Web and 80×24 TUI `/balance elevenlabs`: ready, 0 used / 10,000 included / 10,000 remaining characters, reported October 29 reset. Subscription GET only; **no generation**. |
| Codex | Actual Web `/account codex` and Refresh quotas, plus actual TUI `/account codex`, succeeded (5-hour and weekly windows, checked timestamp). |
| Real Codex import | Actual `/import codex`, selected project conversation ending `267d648c`, confirmed new text-only copy (999 messages), then `/resume` and sidebar opened it. Rendered transcript verified without printing its private content or continuing it with a model. Source remains untouched; imported copy only in test profile. |
| Cursor user-plan login | Owned official SDK flow reaches signed-in browser confirmation. Action-time confirmation requested before key creation. Intended key name: **CG-Next user-plan access**. No key created at this checkpoint. |

Claude prerequisite: installed CLI 2.1.270's bundled definition marks `/usage`
as a local command with noninteractive support. A tool/MCP/customization-disabled,
nonpersistent print probe confirmed **zero turns, zero tokens and $0 cost**.
Its result contained only session statistics, no subscription windows; account
work must handle that absence honestly, not present fresh-session cost as quota.
Cursor's official SDK documents per-agent billed usage, not personal allowance;
the supported subscription view is the account's Spending dashboard.

References: [Claude usage](https://code.claude.com/docs/en/costs),
[Cursor SDK usage](https://cursor.com/docs/sdk/typescript),
[Cursor subscription usage](https://cursor.com/help/models-and-usage/usage-limits).

## Owner retest (PowerShell)

```powershell
Set-Location 'C:\Users\shawn\code\CG-Next'
git switch codex/phase2-live-checks
bun typecheck
bun run test
bun run web
```

Open the printed URL. `/account codex` → Refresh; `/import codex` → select →
confirm → `/resume` the Imported copy. Continuing an imported conversation sends
its text to the selected provider. Existing key route: supply `CURSOR_API_KEY`
in that terminal, then `/model cursor-api/default` and a tiny prompt.
`/login cursor` → Start → official browser confirmation → Check sign-in uses a
separate SDK credential; revoke its named key in Cursor dashboard after testing.
Use `/balance tripo` and `/balance elevenlabs` only; don't generate on low balance.

Shared CLI authentication remains shared even with an isolated `CODEGOBLIN_DIR`.
