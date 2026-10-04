# Agent profiles — independent concern branch

`codex/agent-selection`, based on `codex/phase2-hardening` (`6607a15`), not merged; no PR.

- `/agents` (alias `/agent`) opens a named-profile picker on Web and TUI. Settings also exposes it. Default resets the profile but keeps the selected model.
- Profiles are read from the existing project/global agent roots. `model:` supports a catalog ID, `provider/model`, `inherit`, and Claude's `haiku`/`sonnet`/`opus` aliases. Missing/non-text overrides fail visibly; they never silently fallback.
- The actual primary turn and background subagent resolve the file afresh. Overrides use the target provider's own credentials, never the parent's key. Profile prompts are ephemeral instructions; the selected name and actual model persist in the session.
- `tools:` still restricts offered and executed tools under CG's permission gate. A restricted primary profile cannot widen its tools by enabling `/boost`.
- Resume restores the name. A deleted profile blocks continuation until explicitly reset/reselected. Web validation errors preserve a cleared draft and its attachments.

## Verification

696 tests pass; `bun typecheck`, `node --check src/web/app.js`, `git diff --check` clean. Four new tests cover command aliases, real frontmatter/model parsing, strict missing overrides and target-provider key routing. Two source-wiring guards updated for restricted-profile boost gating.

Actual Web and 80×24 TUI picker/turn/resume checks used a local inference fixture, not a paid model. A `reviewer` file with `model: local/phase1-fixture`, `tools: Read, Grep` produced `agent=seen; tools=read_file,grep` in both surfaces. Web resumed the profile and its Settings button; the picker fits a 390×844 viewport (356px wide). No shared CG auth/session writes.

## Home re-run

```powershell
Set-Location C:\Users\shawn\code\CG-Next
git switch codex/agent-selection
$env:CODEGOBLIN_DIR = "$PWD\output\home-agent-test"
bun run tui -- --model codex/default
# Or, in a separate terminal with the same CODEGOBLIN_DIR:
bun run web
```

Test `/agents` → explore, `/status`, a tiny read-only question, `/resume`, Settings → Agent profile, `/agents default`. Put a custom Markdown profile in `.codegoblin/agents/` with `description`, `model`, `tools` frontmatter; test its exact override, then an invalid override. Missing-provider setup should be visible; no credentials should cross providers. These branch changes need conflict-aware integration with the effort/instructions/account branches before a combined pass.
