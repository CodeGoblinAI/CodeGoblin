# Persisted review state — independent concern branch

`codex/session-review-state`, based independently on `codex/phase2-hardening` (`6607a15`), not merged; no PR.

- Session JSON now retains read-only conversation diff baselines, bounded to 100 files, 256 KiB/file and 4 MiB total. Missing/oversized/unsafe baselines produce a visible incomplete/unavailable notice instead of a false complete diff. Restore binds to the physical workspace root, validates relative paths/junction confinement, and performs no file writes. Baselines contain copies of source text; keep the profile private.
- `/diff` and Web Review diff survive restart/resume. **Undo/redo checkpoints do not persist**; when only restored review state exists, `/undo` explains this rather than claiming no files were changed.
- Activity keeps 100 bounded display-only tool rows and the latest 30-item plan, including subagent tool events. Pending saved rows restore as “not completed,” never falsely as still running or successful. Web Activity/Changes/Plan restore; TUI restores a clearly-labelled latest-12 activity group, its plan and sidebar count. This metadata does not enter the model prompt or execute tools.
- Web persists these records on normal completion, abort and provider errors after a write. Session saves use an atomic temporary-file rename. An interrupted temporary file may remain; no cleanup/delete is performed here.
- Found during the actual pass: live Web Changes used the most recent arguments for every tool result. A batch containing an edit followed by `todo_write` lost the edit's filename. Arguments now match call IDs (including child-tool namespaces), and failed/refused tools do not create successful Changes entries.

## Verification

696 tests pass; clean typecheck, Web JS syntax and diff whitespace checks. Four new tests cover actual file/session baseline round-trip, root/traversal rejection, bounds/warnings, denied/interrupted activity and plan restore. Real Web and 80×24 TUI used a local fixture to request an isolated `notes.txt` edit and plan update through normal approval. Both showed +1/−1. Restart → resume preserved that original before/after diff and completed plan; Web also restored the feed and Changes. The live multi-tool Changes retest passed after the call-ID fix. No paid model or shared-profile writes.

```powershell
Set-Location C:\Users\shawn\code\CG-Next
git switch codex/session-review-state
$env:CODEGOBLIN_DIR = "$PWD\output\home-review-test"
bun run tui -- --model codex/default
# Or: bun run web
```

In a disposable project, approve one small edit and ask for a plan. Inspect `/diff`, stop/quit the app, restart, `/resume` the conversation, inspect diff/activity/plan again. Test a provider failure after an approved edit. Try the same conversation from a different workspace: no original baseline paths should be read. Test `/undo` after restart: it must explain that review is restored but undo is not. Combined integration with the other independently based branches remains necessary.
