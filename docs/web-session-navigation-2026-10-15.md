# Web session navigation — October 15 scheduled pass

Independent branch `codex/web-session-navigation`, based on `6607a15`; no merge or PR.

## Finding and fix

Actual integrated-browser reproduction: select conversation A, then B, while an owned loopback proxy delays A's real `/api/session` response by five seconds. B opens first, then A unexpectedly replaces it. Sending during that interval could also use the previous conversation because the UI had no navigation/loading guard.

The latest navigation intent now wins, including New session. A generation ticket is checked after both the session read and any model-catalog refresh; stale completions cannot replace the transcript or unlock a newer pending switch. Session reads have a 15-second timeout, and failed reads give retry feedback without replacing the current conversation or draft.

While switching, a live status says “Loading conversation…”, the transcript is marked busy, and Send is disabled. Enter explains that the draft/attachments are retained rather than posting into the old conversation. New session remains available, invalidates the pending read, and focuses the composer. Stop is not disabled by the navigation guard. Nothing is automatically sent or retried.

## Verification

**699 tests / 55 files**, clean `bun typecheck`, Web JS syntax and whitespace. Seven added tests cover navigation state, the actual Send guard, and the actual `openSession()` handler with only network/DOM boundaries replaced: reversed response arrival, cancellation during catalog refresh, and failed-read preservation/retry.

Actual browser checks, with real CG session reads through an owned delay proxy:

- Reversed arrival: B stayed selected after late A arrived.
- Enter during the five-second switch retained the typed draft, showed useful feedback, and posted no user turn/inference request.
- New session during a pending read stayed empty after the read returned; the newer draft remained.
- Reloaded the final source and verified New session returns keyboard focus to the composer.

Before/after screenshots are retained locally in ignored `output/playwright/night-session-race-before.jpg` and `night-session-race-after.jpg`. The 15-second timeout path is bounded in code; it was not timed out manually. Failed-read and catalog-await cancellation checks are regression-boundary evidence, not separate manual browser observations.

Only inference was a local fixture; UI, session storage and server were real. Disposable profiles/workspaces, no paid calls, credentials, shared-auth changes or generation. Other branches remain independent. During integration, preserve this same navigation ticket across the extra asynchronous review-state loads from `codex/session-review-state`, and reconcile composer/Send harnesses with the independent composer and recovery branches.

```powershell
Set-Location C:\Users\shawn\code\CG-Next
git switch codex/web-session-navigation
bun typecheck
bun run test
$env:CODEGOBLIN_DIR = "$PWD\output\home-navigation-profile"
bun run web
```

Home checks: rapidly switch two saved conversations; last click wins. Under slow-network throttling, type/Enter while opening a conversation, then choose New session; the draft stays and the late read must not reopen the old conversation. Test an unavailable session and retry. This branch does not contain the independent multiline composer or connection recovery changes.
