# October 4 follow-up — Claude review handoff

Pulled `codex/phase2-hardening` before starting. Its five follow-up fixes are retained at base `6607a15`. Every concern below starts independently at that base, is pushed and tracks origin. **No PRs, base merge or combined integration pass.** The current `codex/phase2-followup-report` branch is documentation only.

## Pushed branches

| Concern branch | HEAD | Individual suite | Record on that branch |
| --- | --- | --- | --- |
| `codex/phase2-live-checks` | `e8ddfc7` | Base: 692 | `docs/live-checks-2026-10-04.md` |
| `codex/configured-instructions` | `367bfc1` | 696 | `docs/configured-instructions-2026-10-04.md` |
| `codex/model-effort` | `0c47cc8` | 696 | `docs/model-effort-2026-10-04.md` |
| `codex/subscription-usage` | `c0ea94c` | 696 | `docs/subscription-usage-2026-10-04.md` |
| `codex/model-command-ux` | `75b07fe` | 693 | `docs/model-command-ux-2026-10-04.md` |
| `codex/agent-selection` | `2b45983` | 696 | `docs/agent-selection-2026-10-04.md` |
| `codex/mcp-oauth` | `bf1bac1` | 698 | `docs/mcp-oauth-2026-10-04.md` |
| `codex/stopped-resume` | `a170b01` | 695 | `docs/stopped-resume-2026-10-04.md` |
| `codex/session-review-state` | `702470b` | 696 | `docs/session-review-state-2026-10-04.md` |

These counts are separate, not additive or a verified combined suite. Implementation branches passed typecheck and applicable Web JS/whitespace checks. No dependencies were added. Shared CG state, original Codex history and the CodeGoblin fork were not modified; state-writing tests used isolated `output/` profiles/workspaces. Keys entered only child-process environments and were never printed, copied into source or committed.

## Live checks and allowance

- **Cursor API-key route:** official SDK catalog and actual Web `cursor-api/default` inference succeeded with `CURSOR_LIVE_OK`. One tiny no-tool request reported 9,101 input / 100 output tokens. This was real inference using the API key, not a quota-only probe. Unreported dollars/context/plan allowance remain unavailable, not zero.
- **Cursor user-plan route:** owned login reached the signed-in official SDK confirmation. The computer-use confirmation is still pending; **no SDK key was created**. Intended exact key name: **CG-Next user-plan access**, saved only in the disposable test profile if authorized. The old pending flow was cancelled; a fresh flow is needed to finish. CLI login and SDK authentication are not interchangeable.
- **Tripo:** actual Web and TUI balance refresh: **0 available / 0 frozen credits**. Balance only; no generation.
- **ElevenLabs:** actual Web and TUI: **0 used / 10,000 included / 10,000 remaining characters**, reported reset October 29 at 3:28 p.m. Balance only; no generation.
- **Codex:** actual `/account codex` and Refresh returned five-hour/weekly windows. Imported one real current-project conversation ending `267d648c` into an isolated CG profile (999 messages), then resumed it in Web; source unchanged. No continuation inference was sent for that imported conversation.
- **Claude allowance safety first:** installed CLI 2.1.270's isolated tool-free, nonpersistent `--print /usage` probe returned **0 turns / 0 tokens / $0**, but only session statistics, not subscription windows. The official experimental `get_usage` control used by the new account adapter sends no user prompt; the live result likewise had zero cost, empty model usage and `rate_limits_available: false`. No live Claude plan percentages are claimed.
- **Cursor subscription usage:** no supported personal plan-quota interface was found. `/account cursor` clearly reports unavailable and links the official Spending dashboard. SDK per-agent cost is not plan allowance; no private quota endpoints or auth-file scraping were introduced.

## Implemented and user-tested

- Configured local instruction files/globs load fresh into system context for TUI, Web, subagents and one-shot; local lean chat keeps those rules. Missing/binary/oversized configured rules fail before inference. No implicit ancestor discovery or URL fetching. Actual Web, 80×24 TUI and one-shot fixture received the rule marker.
- Exact provider/model effort preferences survive model switching and reload. Legacy global effort applies until the first scoped save; then unset models use auto. Unsupported models still omit effort.
- `/agents` and Settings pickers, persisted profile selection, primary/subagent frontmatter `model:` overrides and strict missing-profile/model failures. Target-provider credentials stay separate; restricted profiles cannot widen tools through `/boost`. Actual Web/TUI read-only profile, override, resume and 390×844 picker checks passed.
- Exact slash-model arguments beat prefix matches in both palettes. Web Enter while its catalog loads now explains the wait and keeps drafts/attachments. Actual delayed-catalog Web check and exact-model TUI check passed.
- Hand-rolled hosted MCP OAuth: public PKCE/S256, resource/issuer discovery and validation, DCR or configured public client ID, owned bounded callback, refresh/store, explicit Web/TUI controls, and no automatic tool replay. Real Notion public registration (`CG-Next MCP`) reached **Notion login**, then was stopped/cancelled before credentials/consent. **No workspace grant, Notion token or Notion tool call.** Web phone-width and TUI warning/start/check/cancel checks passed; copying the URL itself was not exercised.
- Partial stopped answers and stopped metadata survive resume; TUI shows the transcript marker. Actual Web mid-stream Stop → server restart → resume, and TUI Ctrl+C → resume passed. Provider wire excludes saved metadata; unexecuted partial tool calls are not retained as executable calls.
- Physical-root-bound read-only diff baselines and bounded activity/plan survive restart/resume. Actual approved fixture edits passed in Web and TUI, preserving +1/−1 and the plan. Also fixed a user-discovered Web multi-tool Changes bug by matching arguments by tool-call ID. **Undo/redo checkpoints remain process-local**, explicitly explained after restart.

Local fixtures drove the actual interactive UIs and CG approval/tool paths; they are not evidence of live model reliability. Real inference is explicitly distinguished above. No fresh Bugbot/security subagent review was run in this follow-up; this report is the requested review handoff.

## Review priorities and remaining work

1. Integrate conflict-aware, then run the combined suite and user pass. Shared hotspots are `agent.ts`, sessions, TUI, Web/server and command/settings wiring. No current branch contains every feature.
2. Reconcile **agent model overrides with per-model saved effort**: the standalone agent branch uses safe auto for explicit overrides; ensure the integrated target model's preference is applied deliberately, without inheriting the parent model's effort/key.
3. Combine configured rules, profile instructions and local lean context once; verify no duplication and no persisted system-prompt leakage. Context estimates may need to account for newly loaded rule bytes.
4. Merge stopped-finalizer and review-state save paths carefully. Test normal completion, stream abort, checkpoint Stop and provider failure after an approved write; keep exactly one stopped marker, partial text, closed committed calls, review metadata and atomic session saves.
5. OAuth security/compatibility review: implementation is a **public-client subset**, not every optional MCP authorization mechanism. No CIMD/confidential clients, fixed pre-registered callback-port configuration, legacy SSE or revocation UI. DNS is checked but not socket-pinned against rebinding. Windows token files inherit directory ACLs; no encryption/owner-only ACL claim. Finish Notion sign-in/consent only with Shawn, then verify a harmless authenticated read and restart/refresh.
6. Finish the owner-confirmed Cursor SDK login and one user-plan inference; record/revoke the named key if created. Keep personal quota unsupported unless an official interface becomes available. Check Claude's experimental control compatibility on CLI upgrades; live quota-window availability remains unverified.
7. Broader accessibility/transcript-copy pass, Phase 3 engine/model installation and other provider/import adapters remain separate follow-ups. Do not label Phase 2 fully complete.

Session profiles can contain copied source baselines, imported conversation text and OAuth credentials. Keep them private; do not stage/share `output/`. Pending callbacks, owned test servers and the current browser handle were closed; no broad process kill or permanent delete was used.

## Home-test commands (PowerShell)

Pick **one** concern branch from the table. This example tests stopped answers. Switching branches does not combine their features.

```powershell
Set-Location 'C:\Users\shawn\code\CG-Next'
git fetch origin
git switch codex/stopped-resume
git pull --ff-only
bun typecheck
bun run test
node --check src/web/app.js

$env:CODEGOBLIN_DIR = 'C:\Users\shawn\code\CG-Next\output\home-stopped-profile'
New-Item -ItemType Directory -Path 'C:\Users\shawn\code\CG-Next\output\home-stopped-workspace' -Force | Out-Null
Set-Location 'C:\Users\shawn\code\CG-Next\output\home-stopped-workspace'
bun C:\Users\shawn\code\CG-Next\src\tui\app.ts --model codex/default
# Web alternative from this same directory/environment; stop the TUI first:
bun C:\Users\shawn\code\CG-Next\src\web\serve.ts
```

Use the URL printed by the Web server. For another concern, replace the branch plus both `home-stopped-*` paths with distinct names. Restart the app after switching. Codex is already authenticated; inference can consume subscription allowance. For balance-only tests, use only the named balance commands, never generation. Each branch's record has its particular config and additional commands.

## Short manual checklist

- **`stopped-resume`:** Stop a visibly streaming answer in Web; Ctrl+C once in TUI. Restart, `/resume`, confirm partial words and exactly one stopped marker. Also Stop at a pending approval; no refused file write.
- **`session-review-state`:** in the disposable workspace approve one small edit and plan update; restart/resume. Check `/diff`, activity/plan, Web Changes and TUI saved activity. `/undo` must explain process-local checkpoints. Also test a provider error after a write and a different physical workspace.
- **`model-command-ux`:** type an exact model that prefixes another; selection must stay exact. Delay catalog loading and press Enter: feedback, retained draft/attachments, no sent prompt. Slash commands remain usable.
- **`model-effort`:** set different effort for two supported exact models; switch/reload/resume. Check an unsupported model and a new unset model.
- **`configured-instructions`:** configure a harmless local `rules.md` in `<CODEGOBLIN_DIR>/config/codegoblin.jsonc` with `{"instructions":["rules.md"]}`; change it between turns. Check local lean chat, one-shot and missing-file failure. Never use secrets as rules: rules go to the provider.
- **`agent-selection`:** `/agents`, Settings → Agent profile, read-only profile, valid/invalid file override, `/resume`, deleted-profile failure, `/agents default`; check restrictions cannot be widened by `/boost`.
- **`subscription-usage`:** `/account claude`, Refresh, `/account cursor`, dashboard link. Unavailable is expected for this live Claude runtime and Cursor quota API; it must not display invented zeros/windows.
- **`phase2-live-checks`:** `/account codex` Refresh, `/import codex` copy confirmation and `/resume`; `/balance tripo`, `/balance elevenlabs` only. Original conversation must remain untouched. `/login cursor` requires renewed action-time confirmation before creating the named SDK key.
- **`mcp-oauth`:** configure Notion as shown in that branch's record; `/mcp` warning/cancel/retry, then **owner** sign-in/consent → Check → harmless read. Restart/refresh. Cancel does not revoke a completed grant.

The shared project brain and `C:\Users\shawn\Downloads\rebuilding-codegoblin.md` were updated with completed concern slices versus owner-gated/integration work. Earlier dated checkpoints there remain historical.

## TL;DR

Nine concern branches are pushed, no PRs or merge. Phase 1 implementation slices and all four optional fixes are delivered and individually user-tested. Cursor API, balances and Codex import/account are live-verified. Cursor SDK confirmation, Notion owner sign-in, usable subscription quota data and combined integration/review remain.
