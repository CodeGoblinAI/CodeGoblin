# Configured instructions

Independent branch `codex/configured-instructions`, based on `6607a15`.
`codegoblin.jsonc`'s `instructions` array now reaches the actual system prompt
in the shared agent loop (TUI, Web and subagents) and one-shot CLI. It is read
fresh for each user turn and isn't copied into saved conversation messages.

Relative entries resolve from the working directory; absolute paths, `~/` and
local globs work. Physical duplicates are omitted in deterministic order.
Limits: 64 files, 128 KiB each, 256 KiB total; binary/missing rules stop before
inference. Globs don't follow directory symlinks or escape their specified base.
Only explicitly configured files are loaded: no ancestor discovery or URLs.
Local chat retains its lean, tool-free system prompt plus configured rules.

Verification: **696 tests**, clean typecheck and diff check. Actual Web UI,
actual 80×24 TUI and one-shot CLI against a local inference fixture all received
the configured marker (`rules=seen`). No paid requests or real-profile writes.

## Test (PowerShell)

```powershell
Set-Location 'C:\Users\shawn\code\CG-Next'
git switch codex/configured-instructions
bun typecheck
bun run test
bun run tui
# In another terminal, from the intended working directory:
bun C:\Users\shawn\code\CG-Next\src\web\serve.ts
```

In an isolated CG profile, configure `{"instructions":["rules.md"]}` in
`<CODEGOBLIN_DIR>/config/codegoblin.jsonc`. Create rules.md in the working
directory with a harmless distinctive answer instruction. Test a prompt in
both surfaces; edit the rule and ask again. Try a missing file and confirm a
visible failure before inference. Never configure secrets as instruction files:
their content is deliberately sent to the selected provider.
