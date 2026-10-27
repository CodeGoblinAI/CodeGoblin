# TUI footer/layout — scheduled user pass, October 15

Independent branch `codex/tui-composer-layout`, based on `6607a15`, not merged; no PR.

## Finding and fix

During an actual streaming reply, typed a long wrapped draft at 80×24. The composer drew six lines but the layout reserved only one because inference was running. The status/footer and clickable toolbar were below the viewport. The before capture in `output/playwright/night-tui-long-before.txt` shows them missing from its 24-row grid.

- Count the actual wrapped draft even while running or awaiting consent; count queued prompts, attached-image notices and back-to-latest pills as well.
- Do not reserve an invisible approval box when the user is editing a draft.
- Bound palette height to available rows, preserving its frame and selected item. Shorten plan/overlay display when necessary, with an explicit resize notice, instead of displacing the composer.
- Shorter responsive key hints leave more room for model/context/cost. An empty pending approval has confirmation/rejection hints rather than the generic streaming hint.

## Verification

**696 tests / 55 files**, clean typecheck and whitespace. Four new tests cover actual footer-height accounting and bounded palette framing/late-item visibility. Existing callers keep the default nine-row palette.

Actual real-PTY checks: six-line draft during a reply at 80×24, resize to 60×18 with the draft intact, slash palette at 60×18, consent box, Reject and Allow once. Rejection left the isolated proposed file absent; Allow once created the expected file through normal CG consent. Context/cost and toolbar were visible in the final narrow layout. Captures are retained under ignored `output/playwright/night-tui-long-after.txt`, `night-tui-60x18.txt`, `night-tui-palette-60x18.txt` and `night-tui-approval-60x18.txt`, each with ANSI source. The last capture precedes the final wording-only change from “enter allow” to the selection-neutral “enter confirm.”

No paid inference or shared profile/auth changes. Only inference was a local fixture, not live model certification. Its canned completion text does not prove a write happened; the rejection/allow claims were checked against actual filesystem state. Very small terminals below the exercised 60×18 size are not certified. Other concern branches remain independent.

```powershell
Set-Location C:\Users\shawn\code\CG-Next
git switch codex/tui-composer-layout
bun typecheck
bun run test
$env:CODEGOBLIN_DIR = "$PWD\output\home-footer-profile"
New-Item -ItemType Directory -Path "$PWD\output\home-footer-workspace" -Force | Out-Null
Set-Location "$PWD\output\home-footer-workspace"
bun C:\Users\shawn\code\CG-Next\src\tui\app.ts --model codex/default
```

Type a long unsent draft while a reply runs; resize to 80×24 and 60×18. Status and toolbar must remain visible. Test slash completion, pending approvals and Escape/Ctrl+C using only a disposable file. Real Codex prompts can consume subscription allowance. Integration must combine this layout work with the queued-draft and current-model-picker branches before a combined pass.
