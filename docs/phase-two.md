# Phase 2 checkpoint — October 4, 2026

Hands-on follow-up: [October 4 user pass](user-pass-2026-10-04.md). A real Codex
approval/write/diff succeeded in the integrated browser, and actual 80×24 TUI
copy/dialog/live-command checks ran. The pass also reproduced a TUI pending-approval
cancellation hang, stale Web approval controls, dynamic-model launch fallback and
picker/export gaps. These remain open despite 686 green tests; do not treat the UX
or Cursor authenticated live verification as complete.

## Current slice: CG-owned Claude, Codex and Cursor tools

The TUI and Web coding agent can now use `claude-code/{default,haiku,sonnet,opus}`
and `codex/default` through the installed official CLIs. Authentication stays in
those CLIs: no OAuth files are read or copied. The Cursor follow-up adds the
owner-approved, pinned official `@cursor/sdk@1.0.35` dependency; it does not wrap
Cursor CLI native tools or reuse private CLI credentials.
Codex's picker refreshes the official `model/list` results; `default` uses the
reported default rather than a stale configured model name.

Both transports propose bounded, schema-validated CG tool requests. The shared
CG agent loop alone executes them, using existing permission rules, Ask/Approve/
Full modes, planning restrictions, MCP consent, checkpoints and undo baselines.
The entire request batch is validated before execution. Partial JSON, unknown
tools, malformed arguments and truncated responses never execute. Pending tool
responses say “Requesting…” rather than claiming a write already succeeded.
Chronological tool results are returned on the next inference call.

- Claude retains safe mode, empty native tools, strict empty MCP configuration,
  disabled slash customizations and no native session persistence. The official
  `--json-schema` option adds only the pure `StructuredOutput` formatter; all other
  native tool calls are refused. Tested with Claude Code 2.1.270.
- Codex uses ephemeral app-server threads, disabled native execution/features,
  disabled configured MCP servers, read-only sandbox and explicit empty environment
  access on both thread and turn. Native requests/items are refused, not passed to
  another executor. Requires CLI 0.153.3 or later; no unsafe fallback for older CLIs.
  This does not promise that every global instruction metadata field is absent.
- CG system instructions, memory, skill index and current planning instructions
  reach the CLI bridge. Conversations compact through tool-free summary requests;
  reported summary tokens count toward session usage. Failed/empty summaries do
  not replace history. CLI prompts/runtime/output remain bounded.
- Images remain unsupported by these text bridges. One-shot CLI prompts remain
  chat-only; use the TUI/Web for CG coding tools. JSON control envelopes are buffered,
  so the reply text is shown after validation rather than token-streamed as raw JSON.
- CLI aliases do not publish an effective model context window here. Both surfaces
  show “context window unavailable,” not a guessed percentage. The bridge's 100k
  transport compaction budget is not a claim about the model's context window.
  Reported tokens can include CLI overhead; no dollar/subscription bill is invented.

Protocol references: [Claude programmatic mode](https://code.claude.com/docs/en/headless),
[Claude CLI flags](https://code.claude.com/docs/en/cli-reference),
[Codex app-server](https://learn.chatgpt.com/docs/app-server).

### Cursor: user plan and explicit API key

- `cursor/default`: `/login cursor` opens a warning/Start dialog. Start creates an
  owned official SDK browser-login attempt. Completing it mints a named SDK user
  key, stored by the SDK in this CG profile's `data/cursor-sdk-auth.json`. This
  replaces that profile's previous SDK sign-in, **not** the shared Cursor CLI login.
- `cursor-api/default`: `/connect cursor-api` accepts an existing user/team API key,
  or use `CURSOR_API_KEY` in the launch terminal. Environment wins over CG's API-key
  store. This route never falls back to the browser key; the browser route never
  falls back to an environment/API/CLI key.
- Both list models using the official SDK catalog when connected. The default
  selects official Auto. No context window, reasoning effort, price or account
  quota is invented. A configured key with a failed catalog is explicitly
  **unverified**, not a confirmed account connection or a zero balance.
- Each inference runs in an owned, bounded worker with `tools: []`, disallowed
  MCP/task capabilities, empty MCP/agents/settings and a fresh empty workspace
  outside the user's project. CG schemas/history are supplied as data. Native
  SDK capability events fail closed; the validated JSON proposals enter the same
  CG permission/execution/undo loop as Claude/Codex. SDK diagnostics are drained,
  not shown in CG history. SDK run records stay in separate per-turn CG cache
  directories, so simultaneous workers do not share a writable JSONL store.
- Tool-free prompt instructions are supplied without SDK system-prompt replacement,
  which Cursor currently gates by account. Invalid envelopes still execute nothing.
  Cancellation stops the owned worker and wakes a blocked reader; late-started
  dialogs cancel their owned attempt. Closing a pending sign-in is not a logout
  or revocation of an already-created key. Revoke a completed SDK key in Cursor's
  account dashboard when needed; `/disconnect cursor` gives this guidance and
  never pretends to clear SDK sign-in. `/disconnect cursor-api` removes only the
  CG-stored explicit key. No SDK credential-file deletion is implemented.
- SDK-created keys are local secrets. SDK storage is not a Windows ACL guarantee:
  anything running as the same Windows account can read them, as with CG API keys.

Correction to the earlier checkpoint: separate SDK authentication does **not**
necessarily mean a separate billing pool. Official Cursor documentation says
user keys bill against the user's Cursor plan; service-account keys bill against
their team. SDK browser login is separate from CLI login. This implementation
provides both supported key routes, not undocumented CLI-OAuth reuse.
[Official SDK authentication, billing and tool allowlists](https://cursor.com/docs/sdk/typescript).

Verification: native package imports under Windows/Bun; the unsigned SDK browser
attempt produced an official link and cancelled from both actual interfaces.
No credential file was created and no shared account was changed. Deterministic
stdio peers cover both auth modes, consent/undo, model sanitization, malformed/
native/truncated failures, credential isolation and cancellation. **Live Cursor
model inference still needs the owner's SDK login or API key.** The fake-key
runtime probe reaches authentication validation, not successful agent creation;
it sends no model prompt and does not prove authenticated inference works.

### Account and sign-in additions

`/balance elevenlabs` now reads used/included/remaining **characters** and the
reported reset time from the fixed official subscription endpoint, using
`xi-api-key`. It is not a cash balance. Missing reset times remain unavailable;
over-limit remaining characters clamp to zero. Redirects, malformed/oversized
responses and errors fail safely. [Official subscription response](https://elevenlabs.io/docs/api-reference/user/subscription/get).

`/login claude` (also `/login claude-code`) and `/login cursor-cli` show guided official
terminal handoffs in both surfaces, with a copy-command button and shared-account
warning. Claude explicitly uses `claude auth login --claudeai`; Cursor uses `agent
login`. These dialogs do not start or cancel external login processes. Codex's
existing owned browser-login flow is unchanged. Fresh login completion remains
an owner opt-in check; no shared authentication was changed during this pass.

### Current verification

- Clean `bun typecheck`, JavaScript syntax checks, 686 tests across 51 files.
- Real stdio peers test whole-envelope validation, native-capability refusal,
  shared consent, planning/deny rules, MCP/checkpoints, file baseline capture,
  compaction failure preservation and reported usage. Codex peers also check
  default-model resolution, early/scoped notifications, policy guards and cancellation.
- Real Claude Web edit: one approval, one isolated file write, final `DONE`, idle.
  Real Claude TUI edit also reached CG consent and wrote only after approval.
- Real Codex one-shot returned `CODEX_CLI_OK`. At 80×24 the real TUI read a file,
  requested a write, and Shift-Tab changed to Approve for me while consent was
  pending, releasing that write. Final `DONE` and TUI/Web conversation diffs were
  checked against the real isolated file contents.
- Codex TUI rejection left the file unchanged and the model stopped. In the Web,
  picking Approve for me while an `edit_file` approval was pending released the
  real edit, followed by `DONE` and an idle composer. Both Claude/Cursor handoff
  warnings were exercised in TUI/Web without copying commands or starting login.
  ElevenLabs' actual Web disconnected popup was checked without making generation
  calls. TUI Ctrl+C stopped active Codex inference and its owned app-server exited;
  the next prompt returned `CANCEL_RECOVERY_OK`. The final browser console contained
  no errors/warnings. Screenshot: `output/playwright/phase2-tools.png`.
- The live pass caught and fixed a prose-before-JSON formatter failure, premature
  “DONE” text, replay of a completed write, and confusion between native read-only
  restrictions and CG's separately approved tool requests. These smoke checks are
  not certification of every model's autonomous reliability.
- Test workspace/profile artifacts remain under `output/phase2-tool-*`. Provider
  smoke calls used a small amount of existing signed-in allowance; automated tests
  use no provider inference or fresh sign-in. No source file was edited by a model.
- Follow-up user pass: real high-effort Codex CG writes completed in the 80×24 TUI
  and headed Web UI. Manual TUI `/compact` left the visible assistant/tool history
  unchanged; the saved conversation retained `system,user,assistant,tool,assistant`.
  SDK warning/Start/pending/Cancel and API-key entry were exercised without completing
  login or saving a real/fake UI key. The pass caught and fixed an incorrect
  `CURSOR_API_API_KEY` Web hint; it now correctly shows `CURSOR_API_KEY`.
- Pending/resolved approval rows at 930px and 760px no longer over-shrink details:
  measured detail widths 252px and 212px, respectively, with no row/body overflow.
  Live Web mode change released the waiting edit once; file contents matched the
  request, final `DONE`, composer idle, no console errors/warnings. This is a
  targeted layout check, not a full responsive/accessibility audit.
  Screenshots: `output/playwright/review-layout-fixed.png`,
  `output/playwright/cursor-sdk-warning.png`. Test/profile artifacts retained.

### What prevents calling all of Phase 2 complete

- **Cursor live inference verification:** both SDK routes and CG-owned tool bridge
  are implemented above, but authenticated model responses require an owner SDK
  user-plan login or API key. No private CLI credentials are reused. ACP was not
  used as the executor because its native approval policy is not CG tool ownership.
- Other CLI subscription quotas and conversation imports still need supported
  interfaces; no private OAuth quota endpoint or undocumented transcript store is
  scraped. Codex quota and explicit text-copy import are implemented separately below.
- Live Tripo and ElevenLabs account success need connected owner keys. HTTP fixtures
  cover their adapters; disconnected states are verified, not live success claims.
- Fresh sign-in and a real private Codex conversation copy/resume remain opt-in
  checks. The implementation/fixture tests do not substitute for these live checks.
- Additional provider adapters require a documented quota/balance API; unsupported
  providers remain explicitly unsupported, never a fabricated zero.

### Review checkpoint — findings fixed after owner authorization

The dedicated Bugbot runner is unavailable in this environment. One read-only
code-review subagent was used as the review-bugbot fallback; it found two P2 issues.
They were initially recorded under the skill's review-only rule. The owner then
explicitly authorized fixes; both are implemented with regression coverage:

| Severity | Location (file:line) | Finding |
|---|---|---|
| P2 | `src/core/context.ts` / `src/tui/app.ts` | Fixed: nonpositive/nonfinite context windows preserve all history, and manual TUI `/compact` reports unavailable/history unchanged instead of using the user-only fallback. Automatic CLI compaction retains its separate known transport budget. |
| P2 | `src/core/providers.ts` / `src/core/claude-cli.ts` / `src/core/codex-chat.ts` | Fixed: Claude Sonnet/Opus/default effort metadata and `--effort` forwarding; Haiku excluded. Codex models use official supported-reasoning metadata, including the default alias. Pure Claude argument tests and real Codex stdio peers verify low/medium/high/auto and actual high-effort transport. |

No additional Bugbot review was run in this fix turn. Passing regression/user
checks verify these fixes; they are not an independent re-review of the new SDK
code. Remaining Phase 2 integrations/live checks above stay open.

The separate visual approval-row finding is also fixed: text/action sections wrap
as rows and long labels/keys cannot squeeze details into a tiny column. Actual
pending/resolved rows and element geometry were checked at both widths above.

### Test commands (PowerShell)

```powershell
Set-Location 'C:\Users\shawn\code\CG-Next'
bun typecheck
bun run test
claude auth status
codex --version
codex login status
bun src/cli/prompt.ts --model codex/default 'Reply with exactly CODEX_CLI_OK'
bun src/tui/app.ts --model codex/default
# Alternative coding-agent launch:
# bun src/tui/app.ts --model claude-code/haiku
# Cursor user-plan route (then /login cursor):
# bun src/tui/app.ts --model cursor/default
# Cursor explicit API-key route (then /connect cursor-api):
# bun src/tui/app.ts --model cursor-api/default
```

In a separate terminal:

```powershell
Set-Location 'C:\Users\shawn\code\CG-Next'
bun run web
```

Open the printed loopback URL (normally `http://localhost:4400`). Restart the server
after imported core changes: Bun does not hot-reload it. For key-free CG profile
isolation, set `$env:CODEGOBLIN_DIR` to a new path under `output` in the launch
terminal. This isolates CG sessions, **not** the shared official CLI login.

### Manual checklist

1. Pick Claude CLI or Codex CLI with the clickable model control. `/status` should
   show that provider's readiness. Codex's model list must be the official live list.
2. In a disposable project, ask to read then edit one test file. Ask mode must wait
   for CG consent. Reject must leave it unchanged; allow once must write it once.
3. While that approval is pending, use TUI Shift-Tab or Web's approval control.
   Approve for me can release normal writes; explicit deny/ask rules and planning
   must still win. Never use Full Access on a real project just to smoke-test this.
4. Check `/diff` (Web Review diff), `/undo`, `/usage`, `/account codex` and `/balance
   elevenlabs`. Context/cost unavailable must not look like zero; account quota and
   session tokens remain separate.
5. Start a long response, stop with TUI Escape/Ctrl+C or Web Stop, then send another
   prompt. No owned CLI inference process or unanswered CG consent should survive.
6. Open `/login claude`, `/login cursor`, `/login codex`; read their distinct warnings.
   Cursor Start/Check/Close should cancel an unfinished owned SDK attempt. Completing
   Cursor login creates/replaces this CG profile's SDK key billed to your user plan;
   it does not log into Cursor CLI. Existing keys use `/connect cursor-api`, never a
   chat message or command-line argument. Model-picker entries are `cursor/default`
   and `cursor-api/default`. After your optional sign-in, send a tiny reply, then an
   approved/rejected disposable-file edit; no native SDK execution should occur.
7. Use `/effort high` on Codex or Claude Sonnet/Opus, then send a tiny prompt. Auto
   omits effort and Haiku does not receive it. Manual `/compact` on unknown-window
   CLI/SDK models must report history unchanged. At 930px with both Web sidebars open,
   pending and resolved approvals must retain readable details/actions.
8. Optional with owner keys: refresh Tripo/ElevenLabs balance and check fields/reset.
   Optional with owner approval: confirm one `/import codex` copy, then `/resume` it;
   the source and current session must remain untouched.

## Archived first slice — September 20, 2026

The checkpoint below describes the initial chat-only implementation. The current
October 4 tool bridge above supersedes its tool/compaction limitations.

### Claude CLI chat connector

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

## Phase 2 follow-up checkpoints

### Account telemetry slice — October 3, 2026

Implemented shared live balance snapshots in the TUI and Web UI:

- `/balance` checks the selected provider; `/balance deepseek` or `/balance tripo` checks that provider without switching models. `/credits` is an alias.
- `/usage` and the TUI Usage button include account balance separately from session tokens, estimated cost and context.
- DeepSeek retains total/granted/topped-up amounts and their USD/CNY currencies. Tripo retains available/frozen API credits; those are not USD or Studio subscription quota.
- Checked timestamp and explicit snapshot freshness, with a Web Refresh balance button and refresh-on-reopen in the TUI. No background polling or persisted balance cache.
- Disconnected, unsupported, refused, malformed and timed-out responses do not turn into zero balances. Credentials only go to fixed HTTPS provider endpoints; redirects are refused, response size/runtime are bounded, and provider bodies/errors are not exposed.

Documented endpoints: [DeepSeek balance](https://api-docs.deepseek.com/api/get-user-balance), [Tripo account balance](https://developers.tripo3d.ai/en/docs/account).

Verification: clean `bun typecheck`, 649 passing tests across 46 files. HTTP fixture tests cover currency precision, real zero, insufficient funds, frozen credits, authorization/server errors, malformed/oversized bodies, duplicate currencies, redirects and a stalled stream. Actual TUI at 80×24 and headed Web UI showed live DeepSeek amounts and its insufficient-funds status. Web refresh updated the timestamp. Tripo had no connected key, so its disconnected state was tested interactively; **Tripo live-account success remains unverified**. No model generation or subscription calls were made for this slice. Existing API keys were used only for read-only balance requests, not copied into profiles or logged.

The interactive pass shortened balance status text and separated freshness from the timestamp to avoid clipping in the TUI. Screenshot: `output/playwright/phase2-balance.png` (initial pass, before that wording adjustment).

### Commands to test (PowerShell)

```powershell
Set-Location 'C:\Users\shawn\code\CG-Next'
bun typecheck
bun run test
bun script/check-balance.ts deepseek
# Requires an existing Tripo API key; otherwise reports disconnected and exits 1:
bun script/check-balance.ts tripo
bun src/tui/app.ts --model deepseek
```

In another terminal:

```powershell
Set-Location 'C:\Users\shawn\code\CG-Next'
bun run web
```

Leave that terminal running and open `http://localhost:4400` in your browser. Use the printed URL if port 4400 is busy. For isolated, key-free tests in a new terminal, set `$env:CODEGOBLIN_DIR = 'C:\Users\shawn\code\CG-Next\output\manual-phase2-profile'` before launching. Existing provider-key environment variables still take precedence.

### Manual checklist

1. In both interfaces: `/balance deepseek` shows provider amounts, currency, status and checked time. A valid zero/insufficient balance is not a network error.
2. `/usage` keeps session usage/cost distinct from account funds and subscription quota. In the TUI also click Usage; at 80×24, status, timestamp and freshness should be readable.
3. Web: click Refresh balance and confirm the timestamp advances. Close the popup while a check is running; a late response must not reopen it. TUI: close and reopen `/usage` to refresh.
4. `/credits tripo` behaves like `/balance tripo`; without a key it requests connection, not a top-up or generation. With your own key it should show available and frozen credits separately. Live Tripo success still needs this check.
5. `/balance claude-code` reports unsupported, not a fabricated subscription balance. `/balance` uses the currently selected provider.
6. Optional failure test in a fresh terminal: temporarily set `DEEPSEEK_API_KEY` to an invalid test value and launch the check script or UI. It should show authorization refused with no key/raw response in the UI. Close that terminal afterward; do not overwrite a stored real key.
7. Previous slice: `/model tripo/text-to-model`, `/settings 3d.topology quad`, `/set 3d.topology`, and `/settings` exercise save/reset/popup without generating anything. After an approved coding-agent file edit, `/diff`, `/changes`, and Web Review diff should show the conversation change.

### Remaining Phase 2 work

- Tool-enabled CLI integration with an explicit approval-ownership bridge.
- Cursor and Codex connectors using their supported protocols.
- Other CLI subscription usage/reset displays; Codex snapshots are implemented below.
- Additional provider balance adapters and live Tripo account verification; DeepSeek live balance is verified.
- Claude/Cursor sign-in handoff; Claude login remains external via its official CLI.
- Other CLI session imports; Codex text-copy import is implemented below.

Protocol reference: https://code.claude.com/docs/en/headless
Flags reference: https://code.claude.com/docs/en/cli-reference

### Codex account / import slice — October 3, 2026

Implemented `/account codex`, `/login codex` and `/import codex [session-id]` in both surfaces, using the installed official CLI's [app-server protocol](https://learn.chatgpt.com/docs/app-server). This is an account/history client, **not a Codex inference connector**. It never starts a thread or turn and refuses every unsolicited native tool/approval request. No dependencies added; no credential files read or copied.

- `/account` also works without the `codex` argument. Shows reported used and remaining percentages for primary/secondary quota windows, window duration, local reset time, checked time and snapshot freshness. Prefer all named quota buckets when supplied. Null/missing windows are unavailable, not zero; remaining percentage is clamped at zero. API-key mode does not invent subscription quotas. Safe display fields are cached in the CG-Next profile; cached snapshots older than five minutes are marked stale. Manual refresh only, no quota polling.
- `/login codex` shows a warning before starting: completing sign-in can change the shared official CLI account. Start creates a bounded official browser sign-in attempt; CG-Next only opens validated HTTPS `auth.openai.com` URLs. Check completion manually; close/cancel ends only that owned attempt, not the shared account's existing login. Login URLs stay in memory. CLI lifetime, cancellation and application shutdown are bounded.
- `/import codex` lists only the current project's Codex conversations, with timestamps/short-ID hints to distinguish duplicate names. Selecting an entry opens confirmation; no copy happens until confirmation. The direct-ID form still confirms and verifies project ownership. Import creates an exclusively written new CG-Next session with provenance and a separate ID. Source/current conversation are not resumed or overwritten. Only user and assistant text survives; tools, images, reasoning and hidden prompts are omitted. Open the new copy separately with `/resume`. Oversized/empty transcripts and mismatched source IDs are refused.
- Account display is available during a running response; sign-in/import commands queue until it ends. Existing CG-Next permission modes do not enable any native CLI tools.

Verification: clean typecheck and JavaScript syntax check; 661 tests across 47 files. Deterministic stdio peer tests exercise actual request correlation, malformed initialization, timeouts, protocol-error redaction, native-tool refusal, safe on-disk cache, signed-out/API-key/read-failure distinctions, early login completion, cancellation, stopped-client status, URL validation, project filtering, new-session save/load, current-session preservation and text-only import bounds. Test state is sandboxed; no provider inference or sign-in occurs in automated tests.

Interactive checks used an isolated TUI profile at 80×24 and a headed browser profile. Live official Codex account reads and Web refresh returned five-hour and weekly windows with advancing checked timestamps. Sign-in warning/start panels were opened without starting a fresh real login. Actual project session lists, selection confirmation and cancellation were exercised without copying a private conversation. A nonexistent import ID returned a safe error and no new session; its expected HTTP 400 was the browser's only resource error. Closing a loading quota popup left it closed after the response. Import persistence and login completion are fixture-verified; **fresh browser-auth completion and a real conversation-copy/resume still need the owner's opt-in verification**. Screenshot: `output/playwright/phase2-codex-account.png`. The pass shortened clipped quota text, fixed direct `/login` rendering, added date-plus-ID hints even for same-timestamp duplicate titles, and prevented late import responses from reopening a closed dialog.

#### Test commands (PowerShell)

```powershell
Set-Location 'C:\Users\shawn\code\CG-Next'
bun typecheck
bun run test
codex --version
codex login status
bun script/check-account.ts
bun run tui
```

In another terminal:

```powershell
Set-Location 'C:\Users\shawn\code\CG-Next'
bun run web
```

Open the printed localhost URL (normally `http://localhost:4400`). Optional isolated profile before launch: `$env:CODEGOBLIN_DIR = 'C:\Users\shawn\code\CG-Next\output\manual-codex-profile'`. This isolates CG-Next state, **not the official CLI's shared authentication**.

1. `/account codex`: check used/remaining, primary/secondary windows, reset time and freshness. Refresh; checked time should advance. Close during loading; it must stay closed.
2. `/login codex`: inspect the shared-account warning and cancel. Only choose Start and complete browser sign-in if you intend to change/reconfirm the official CLI account; closing cancels the owned attempt.
3. Select a text model, then `/import codex`: identify a conversation by title/date, open confirmation and cancel first. Nothing should appear in Sessions. With a source you choose to copy, confirm and `/resume` the `Imported:` entry. Current/source stay unchanged; tool execution and credentials are not imported. The transcript copy contains your conversation text and will be sent to your selected provider if you continue it.
4. During generation, `/account codex` should open immediately; `/login codex` and `/import codex` should queue. Stop/copy/approval controls must continue working.
5. Signed-out/unsupported CLI, API-key quota-unavailable, failed import, and stale-cache states must remain distinct from a genuine zero-usage window.

Additional headed-browser screenshot: `output/playwright/phase2-codex-import.png` shows date-plus-ID disambiguation in the project session list. Owned test TUI/Web/browser processes were stopped after the pass; profiles and screenshots are retained.

Remaining: native-tool approval ownership, Codex/Cursor inference connectors, Claude/Cursor quota/login/import work, other provider balances and live Tripo account verification. Phase 2 is not complete.
