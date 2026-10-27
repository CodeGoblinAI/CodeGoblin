# Scheduled hands-on UX pass — October 15, 2026

One-time 1:53 AM Eastern continuation, completed without renewing an automation. Work was in **CG-Next**, not the original CodeGoblin fork. Four new concerns are pushed, each independently based on `codex/phase2-hardening` (`6607a15`). No PR, merge, base update or silent integration.

## Review handoff for Claude

| Branch / code commit | Finding and change | Individual verification |
| --- | --- | --- |
| `codex/queued-command-drafts` / `265e218` | Web and TUI erased a newer unsent draft when a queued model command executed. Preserve newer text and Web image-only drafts while allowing command argument preparation when no newer draft exists. | 695 tests / 55 files; real PTY regression; actual Web/TUI before/after |
| `codex/tui-composer-layout` / `3dcda8c` | Wrapped drafts during streaming reserved too little height, pushing the footer/toolbar offscreen. Count real visible rows, constrain palettes/overlays, compact narrow hints and label pending approval keys accurately. | 696 tests / 55 files; actual 80×24 and 60×18 PTY checks, approval Reject and Allow once |
| `codex/web-composer-ux` / `80f020c` | Shift+Enter silently concatenated lines in the single-line field. Accessible auto-growing textarea, native multiline/copy, truthful queue hints, wrapping model/mode controls and larger aligned action targets. | 695 tests / 55 files; actual native keys/copy/paste, desktop/760px/390px views |
| `codex/web-session-navigation` / `38f9cef` | A slow old conversation response replaced the conversation clicked last. Latest navigation wins; New session invalidates pending reads; loading feedback and Send/Enter guard preserve drafts. | 699 tests / 55 files; real delayed session reads, late-arrival and New/Enter checks |

All four have clean `bun typecheck` and whitespace checks; changed Web JS also passes `node --check`. Counts are **not additive or a combined suite**. The current checkout is the navigation branch; it does not include the other fixes. Each branch has its own `docs/*-2026-10-15.md` record with implementation/verification details.

Earlier October 15 work remains separate: `codex/web-connection-recovery` (`ed36760`, docs HEAD `73d3ffc`) and `codex/tui-model-picker-current` (`fdbc604`). Earlier October 4 concern branches also remain unmerged. See `docs/user-pass-2026-10-15.md` on the model-picker branch and the October 4 consolidated report on `codex/phase2-followup-report`.

## Actual user evidence versus fixtures

Used the integrated browser and a step-driven **real Windows PTY**. Only inference was deterministic and local. CG command dispatch, consent, file tools, sessions, keyboard/mouse handlers and rendering were real. All writes stayed in ignored disposable profiles/workspaces. No paid inference, generation, account balance calls, sign-in, credential creation or shared-auth changes.

- Both UIs: start a slow response, queue an exact `/model` switch, type a newer draft, wait for completion. Draft loss reproduced, then retested fixed. The PTY regression also exercises queued prompts and `/clear` without extra inference calls.
- TUI: long wrapped draft during streaming at 80×24; resize to 60×18 without losing the draft; bounded slash palette; readable footer and clickable toolbar. Pending consent was exercised with Reject, then Allow once. Filesystem checks, not the fixture's canned final prose, proved rejection left no file and approval created the expected isolated file.
- Web: Shift+Enter inserts a newline, Enter sends one multiline message, Ctrl+A/C copies the exact two-line sample, and Shift+Enter does not accept an open mention completion. A 24-line paste retained all lines while scrolling inside the 156px field; clear/send shrinks it.
- Web layout: actual 1280×720, 760px with both sidebars, and 390×844. Model/mode controls and Send stay within the composer; no horizontal page overflow in the exercised views. Inspected screenshots containing ordinary prose, a code block, list and table.
- Web sessions: owned loopback proxy delayed alternating real session reads by five seconds. A→B stayed on B despite late A; Enter during loading kept the draft without inference; New session remained new after the delayed read. Final source reload verified composer focus after New.
- Earlier same-date handoff covers actual Settings/Help/mention keyboard flows, mobile drawer and scroll preservation, selected-text TUI Ctrl+C, current-model picker and connection-recovery/Stop checks. Those are earlier evidence, not a claim that every path was repeated on these four independent branches.

Regression-only boundaries include Web image-only queued draft restoration, failed session reads, cancellation while refreshing a missing model catalog, and the precise Send/Stop state guard. The 15-second session-read timeout was not manually exhausted. Local usage numbers and zero cost are fixture declarations, not certification of real provider accounting or quota reporting.

## Visual evidence retained locally

Actual screenshots, not mockups, under `C:\Users\shawn\code\CG-Next\output\playwright`:

- `night-web-composer-before.jpg`
- `night-web-composer-after-desktop.jpg`
- `night-web-composer-after-phone.jpg`
- `night-session-race-before.jpg`
- `night-session-race-after.jpg`

Before/after composer transcript content differs; comparison is of composer geometry and behavior. Composer screenshots show that branch, not an integrated build. TUI before/after rendered-grid captures and their raw `.ansi` sources include `night-tui-long-before.txt`, `night-tui-long-after.txt`, `night-tui-60x18.txt`, `night-tui-palette-60x18.txt`, `night-tui-approval-60x18.txt` and `night-tui-approved-60x18.txt`. The approval capture precedes the final wording-only “enter confirm” adjustment.

Evidence and fixtures are ignored local files, not pushed source assets. Test servers/proxy, owned PTYs and browser tab were stopped; temporary viewport override reset. No files permanently deleted. Existing unrelated untracked scripts/chat export and `.claude/` were preserved.

## Home commands — choose one branch at a time

Stop the running app before switching. Check `git status` first; do not discard unrelated changes. Full source checks for the current concern:

```powershell
Set-Location C:\Users\shawn\code\CG-Next
git status --short --branch
git switch codex/web-session-navigation
git pull --ff-only
bun typecheck
bun run test
node --check src/web/app.js
```

Replace the branch above with `codex/web-composer-ux`, `codex/tui-composer-layout` or `codex/queued-command-drafts` to test that concern. On the queued-draft branch also run `node script/test-live-controls.mjs` (uses the existing Windows PTY dependency from the original fork).

### No-allowance local fixture path on this machine

The ignored fixture files are retained on this machine, not available automatically on a fresh clone. Terminal 1, leave running:

```powershell
Set-Location C:\Users\shawn\code\CG-Next
bun .\output\ux-night-fixture.ts
```

Terminal 2, Web on the chosen branch:

```powershell
$cgRoot = 'C:\Users\shawn\code\CG-Next'
$cgSandbox = Join-Path $cgRoot 'output\home-night-web-workspace'
New-Item -ItemType Directory -Path $cgSandbox -Force | Out-Null
$env:CODEGOBLIN_DIR = Join-Path $cgRoot 'output\home-night-web-profile'
$env:CODEGOBLIN_LOCAL_URL = 'http://127.0.0.1:4425/v1'
$env:CODEGOBLIN_LOCAL_MODEL = 'ux-night'
$env:CODEGOBLIN_LOCAL_TOOLS = '1'
$env:CODEGOBLIN_LOCAL_CONTEXT = '16384'
Set-Location $cgSandbox
bun "$cgRoot\src\web\serve.ts"
```

Open the address the server prints (normally `http://localhost:4400`), select **Local ux-night**. For deterministic session-race testing only, ensure CG prints port 4400, then run this in Terminal 3 and open `http://localhost:4426` instead. The owned proxy delays every other session read by five seconds; restart it to reset the counter.

```powershell
Set-Location C:\Users\shawn\code\CG-Next
bun .\output\ux-night-session-proxy.ts
```

TUI alternative in Terminal 2, with the same inference fixture running and Web stopped:

```powershell
$cgRoot = 'C:\Users\shawn\code\CG-Next'
$cgSandbox = Join-Path $cgRoot 'output\home-night-tui-workspace'
New-Item -ItemType Directory -Path $cgSandbox -Force | Out-Null
$env:CODEGOBLIN_DIR = Join-Path $cgRoot 'output\home-night-tui-profile'
$env:CODEGOBLIN_LOCAL_URL = 'http://127.0.0.1:4425/v1'
$env:CODEGOBLIN_LOCAL_MODEL = 'ux-night'
$env:CODEGOBLIN_LOCAL_TOOLS = '1'
$env:CODEGOBLIN_LOCAL_CONTEXT = '16384'
Set-Location $cgSandbox
bun "$cgRoot\src\tui\app.ts" --model local/ux-night
```

Use `[slow]` to get a 30-second response, `[layout]` for structured output, and `[write] tui` for a consent-gated `tui-approved.txt` proposal. Use a fresh disposable workspace for the initial Reject check; do not overwrite a personal file. The canned “Approved file write completed” reply is not evidence of approval: inspect the actual file. Exit the app and stop fixture/proxy with Ctrl+C. These environment variables are local to those test shells; close them afterward to avoid using the fixture accidentally.

### Home checklist

- Queued drafts: `[slow]`, queue `/model local/ux-night`, then type a newer unsent message. It remains after the command. Repeat `/clear`; Web image-only restoration too.
- TUI layout: long wrapped draft while running at 80×24 and 60×18. Status/toolbar remain visible; slash palette fits. Reject and Allow once do what they say; test Escape/Stop without sending the draft.
- Web composer: multiline typing/paste/copy, Shift+Enter with completion open, Enter once, grow/shrink, Stop, plus/mentions, 760px and phone widths, both sidebars.
- Session navigation: create two fixture conversations, then rapidly click A and B through the delay proxy. B stays open. During loading type/Enter, then choose New; no unintended turn and no late session replacement.
- After integration only: repeat Settings/model/session pickers, copy, transcript scrolling, attachments, Stop/resume, honest usage displays and all above on a single build. Existing signed-in `codex/default` can replace the local fixture for owner live testing, but real prompts can consume allowance.

## Review risks / what remains

- Merge by intent: several branches touch `src/web/app.js` composer reset, queued handoff, Send/Stop and session restoration. Composer tests that extract actual functions will need the new navigation-state dependency when combined. Preserve newer-draft behavior on every failure/queue path.
- `codex/session-review-state` adds asynchronous review loads; carry the navigation ticket through those awaits. Reconcile connection-recovery and stopped-resume terminal/save paths with agent-selection validation.
- TUI footer changes and current-model-picker changes are independent; combine without losing popup selection or viewport accounting.
- Queued model/reset controls are verified; delayed custom-command/plan/boost continuations need a dedicated follow-up. Terminals below 60×18, a full accessibility audit, real-model context/cost accounting and the combined branch suite are not certified by this pass.
- Owner Cursor user-plan key/consent and Notion login/tool verification remain handed off; no new auth actions were taken. Earlier API-key/balance/import live evidence remains in the October 4 report.
- Downloads checklist updated. Project-brain skill still absent from the saved `.skills` and `.agents/skills` paths; no replacement was silently created.

TL;DR: Four new, independently pushed UX concerns fix queued-draft loss, offscreen TUI controls, missing Web multiline editing, and stale session navigation. Actual UI retests plus individual passing suites; integration and owner live-model pass remain next.
