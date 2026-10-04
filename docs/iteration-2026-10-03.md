# Implementation iteration — October 3, 2026

## Delivered

- TUI/Web `/settings` and `/set` parity. With no arguments, keep the existing settings popup. With `3d.topology quad`, save the selected model's value; with `3d.topology` alone, reset it. Invalid choices and settings belonging to another model are refused. Validation lives in core/media-settings.ts and is also used by Web picker posts.
- Web `/diff` / `/changes`: reuse core/changes.ts and the conversation's existing undo history. Show file status/counts, collapsible hunks, before/after line numbers, colored additions/removals and oversized-diff notices. File content uses textContent, not HTML.
- A keyboard-accessible Review diff button in the activity sidebar also opens the viewer, including after resuming a conversation in the same server run.

## Verification

- `bun typecheck`: passed.
- `bun run test`: 635 passed, 0 failed, 45 files. Replaced duplicated test-only validation with tests of the actual shared validator.
- Actual interactive TUI in an isolated profile: selected Tripo text-to-model, saved quads through `/set`, refused `nonsense` through `/settings`, reset to provider default, and opened the settings popup with no argument.
- Headed browser with an isolated profile and local deterministic OpenAI-compatible fixture: selected local/fixture, sent a prompt, approved write_file once, and opened `/diff`. The viewer showed output/iteration-diff.txt as added (+2), with numbered lines and literal `<script>` text, not execution. Also exercised settings save, refusal and reset with both aliases.
- Browser page reload, session resume, sidebar Review diff, and no-conversation empty state exercised. Screenshots retained under output/playwright/iteration-diff*.png; fixture/profile retained under output/iteration-*.
- The expected HTTP 400 on an invalid settings value was the browser's only recorded resource error during the initial pass. No paid API calls were used.

## Known boundaries / next work

- Undo-history baselines are in memory, not persisted with the transcript. After a server restart the viewer reports history unavailable. Persisting those baselines is separate work.
- Resuming restores transcript messages but not activity rows. The Review diff button stays accessible and can read history still held by this server.
- General interface preferences remain popup-controlled; direct arguments address model-generation settings, not every interface preference.
- Subsequent Phase 2 slices delivered DeepSeek/Tripo balance adapters and Codex quota, sign-in-handoff and text-copy import controls. See phase-two.md for current verification and remaining CLI inference/tool-ownership work; this earlier iteration closed command/UX gaps first.

## Launch / check commands (PowerShell)

```powershell
Set-Location 'C:\Users\shawn\code\CG-Next'
bun typecheck
bun run test
bun run tui
# In a second terminal:
Set-Location 'C:\Users\shawn\code\CG-Next'
bun run web
```

Select a 3D model and try `/settings 3d.topology quad`, `/set 3d.topology`, and `/settings`. After an approved coding-agent file edit, try `/diff`, `/changes`, or the Web sidebar's Review diff button.
