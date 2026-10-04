# Subscription account snapshots

Independent branch `codex/subscription-usage`, based on `6607a15`; no PR.

`/account claude` (`claude-code` alias) now follows the Codex account pattern:
manual refresh, display-only cache, checked time/five-minute freshness, reported
used/remaining percentages and reset windows. It uses the installed official
CLI's experimental `get_usage` control request with `skip_behaviors:true`;
**no prompt is sent, no transcript scan, no OAuth-file reads or copied tokens**.
All native actions are refused; stdio output and lifetime are bounded, errors
are redacted, and only display fields are cached. CLI incompatibility, missing
subscription sign-in and absent windows remain unavailable, not zero.

First verified allowance safety: installed CLI 2.1.270 defines `/usage` as local
and noninteractive. Tool-free, customization-disabled, nonpersistent print
probe reported zero turns/tokens/$0. Its plain-text result only had fresh-session
stats. The newer structured control request also returned $0 and empty model
usage, with `rate_limits_available:false`, `subscription_type:null`. This machine
doesn't currently expose Claude subscription windows through that official route;
**live success with a signed-in Claude plan remains to verify**. No fresh shared
Claude login attempted. Fixture coverage proves real zero, over-limit clamping,
missing/malformed fields, correlated control requests, timeout/native-action
refusal, unsupported versions and no private/cache/error leakage.

`/account cursor` gives an honest unavailable state and official Spending
dashboard action (Web opens it; TUI copies the URL). The official SDK exposes
per-agent billed tokens/cost, **not personal subscription allowance**, and team
Admin API credentials are a different credential class. No user key is sent to
undocumented quota endpoints, and no model call is made to ask about allowance.
This is a supported fallback, **not a completed programmatic Cursor quota API**.

Verification: **696 tests**, clean typecheck/JS syntax/diff checks. Actual Web
Claude refresh/unavailable and Cursor dashboard states, plus actual 80×24 TUI
Claude account panel. Profile isolated under `output/subscription-profile`.
Screenshot: `output/playwright/subscription-account.png`.

References: [Claude usage](https://code.claude.com/docs/en/costs),
[Cursor SDK](https://cursor.com/docs/sdk/typescript),
[Cursor allowance](https://cursor.com/help/models-and-usage/usage-limits).
Claude control schema was inspected in the installed official executable;
experimental compatibility is intentionally checked at runtime, not assumed.

## Test (PowerShell)

```powershell
Set-Location 'C:\Users\shawn\code\CG-Next'
git switch codex/subscription-usage
bun typecheck
bun run test
bun run tui
# Another terminal:
bun run web
```

Both surfaces: `/account claude` → Refresh quotas; confirm unavailable never
looks like 0%. With an already signed-in subscription, check returned windows
and reset times. `/account cursor` should explain the distinction and offer the
dashboard. `/account codex` must remain unchanged. Close during refresh; late
results must not reopen the popup. Sign-in is explicit and can change shared
official CLI authentication; isolated CG profiles do not isolate that account.
