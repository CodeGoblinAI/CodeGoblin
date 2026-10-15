# Queued control drafts — October 15 scheduled pass

`codex/queued-command-drafts`, independently based on `6607a15`; no merge or PR.

Actual Web and 80×24 TUI reproduction: start a slow local-fixture reply, queue `/model local/ux-night`, then type a newer unsent message. When the model switch ran, both composers became empty. The queued command handoff preserved drafts only for ordinary messages, not slash controls.

The handoff now restores a newer text draft after a queued control; Web also restores an image-only newer draft and refreshes composer controls. When no newer draft exists, a command may still populate its argument field. This slice is verified for model/reset controls; it is not certification of every delayed custom-command/plan/boost continuation.

Verification: **695 tests / 55 files**, clean typecheck, Web JS syntax and whitespace. Three new tests execute the Web's actual handoff fragment with a small UI/send boundary. The expanded real Windows PTY regression exercises queued prompt, model and clear controls and checks no extra inference request is sent. `node script/test-live-controls.mjs` passes. Actual integrated-browser and step-driven TUI retests kept the newer draft after the model command completed. Captured terminal output is retained under ignored `output/playwright/night-tui-queue-after.txt` with its `.ansi` source; screenshot evidence was inspected in the browser pass.

No paid inference, shared auth changes or account actions. Only inference was fake; CG commands, UI and saved conversations were real, in disposable profiles/workspaces. Older concern branches remain separate.

```powershell
Set-Location C:\Users\shawn\code\CG-Next
git switch codex/queued-command-drafts
bun typecheck
bun run test
node script/test-live-controls.mjs
$env:CODEGOBLIN_DIR = "$PWD\output\home-queued-draft-profile"
bun run tui -- --model codex/default
# Web alternative after stopping TUI: bun run web
```

Home check: during a reply, queue `/model` with the exact current ID, then type an unsent draft. Let the reply finish; the model control should execute and your newer draft should remain. Repeat with `/clear` and Web image-only drafts in a disposable project. Real Codex prompts can use subscription allowance.
