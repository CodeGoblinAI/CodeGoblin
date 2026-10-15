# Web connection recovery — hands-on pass, October 15

Branch `codex/web-connection-recovery`, independently based on `codex/phase2-hardening` (`6607a15`). No PR or base merge.

## Found and fixed

With the owned Web server stopped, typed a draft and pressed Enter in the actual in-app browser. The UI emptied the composer and said **request cancelled**, although no cancellation was requested. Unexpected mid-stream transport failures were also labelled as stopped.

- Connection failure and user Stop are now distinct. A stream that errors or ends without a saved/error terminal event warns that the answer is incomplete and tools may already have run. No automatic request/tool retry.
- A failed initial request or rejected HTTP response restores text and attachments if the composer is empty. If a newer draft exists, it stays in place; explicit **Restore unsent message / Restore newer draft** controls swap both drafts and their images without sending anything.
- A per-request abort signal and explicit cleanup keep the Stop path separate. Explicit Stop still ends with the stopped marker, not the connection warning.
- A lost response is not proof that the server did nothing: the error asks the user to check `/resume` before resending. This does not add durable browser drafts or solve the separately branched stopped-answer persistence work.

## Actual UI verification

Used isolated `output/ux-oct15-*` profiles/workspace, actual Web UI and 80×24 TUI. Only inference was a deterministic loopback fixture; a separate owned reverse proxy exercised HTTP rejection and transport drops. No paid model calls, account sign-in, key changes or external uploads.

Passed in the Web UI:

- Settings keyboard navigation/Escape and composer focus return.
- Plus → file mention → Down/Tab; Help → filter → choose command with Send enabled.
- Long transcript; scrolling up while new chunks arrive preserves the reader's position.
- Phone-width 390×844 layout and Sessions drawer.
- Actual unreachable request restores the draft, enables Send and shows a connection error, not cancelled.
- Delayed HTTP rejection keeps a newer draft; both restore controls recover the appropriate draft.
- A disposable SVG attachment and its text both restore after rejection.
- Accepted stream drop preserves visible partial text, warns about incomplete output/prior tools, and returns idle without retry.
- Explicit mid-stream Stop produces a stopped marker; a subsequent normal prompt succeeds.

TUI Settings/help, a live `/thinking` command, and selected-text Ctrl+C were also exercised. Ctrl+C reported selection copied, preserved the draft and left the process open. **Found separately:** the clickable Model picker initially highlights DeepSeek rather than the active Local model; that fix belongs on `codex/tui-model-picker-current`, not this branch.

Verification: **695 tests pass**, clean `bun typecheck`, `node --check src/web/app.js` and `git diff --check`. Three new tests execute the browser's actual transport-failure decision function. The interaction tests above are actual UI observations, not a claim that those three unit tests cover the whole browser.

## Home checks

```powershell
Set-Location C:\Users\shawn\code\CG-Next
git switch codex/web-connection-recovery
git pull --ff-only
bun typecheck
bun run test
$env:CODEGOBLIN_DIR = "$PWD\output\home-web-recovery-profile"
bun run web
```

Use only disposable drafts/workspaces. Stop this owned server from its terminal, leave the page open, type a message and press Send. Expect the draft to return with useful connection feedback. Restart and reload before continuing. A delayed rejection with a newer draft, attachment restoration, and an interrupted accepted stream are additional checks; never assume a failed response means tools did not execute. Normal inference can consume allowance when using a real model.

These checks do not integrate the October 4 concern branches. The brain skill is currently missing at its saved locations; repository records and the Downloads checklist are the fallback until it is restored.
