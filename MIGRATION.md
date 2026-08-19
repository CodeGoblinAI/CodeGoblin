# CodeGoblin — build-up plan

A fresh repo that depends on published libraries instead of forking them, so
this git history contains only our commits.

## Why build up

Tearing down a fork means forever proving a negative: every deletion needs
proof that nothing references it. Three passes on the fork removed 91 files
and ~9,400 lines, and verification caught three false positives that would
have broken the publish script, a workflow, and a Help menu link.

Building up inverts the default. Nothing is here unless we put it here.

## Status

Domain code ported: **27 files, 5,516 lines**, of which **18 typecheck clean**
with no changes at all. The rest fail only because four modules have not been
ported yet.

## Dependencies, not forks

Pi ships as MIT packages under `@earendil-works/`. Depending on them keeps
Pi's ~5,700 commits in `node_modules` and out of our history, upgrades arrive
via `npm update` instead of merge conflicts, and MIT notices live in
`node_modules` rather than becoming our bookkeeping. Copy code only where no
package exists — copying obliges us to carry that project's notice forever
and to maintain the code with no upstream fixes.

## What Pi does NOT provide — we own these

Verified against Pi's public type surface:

| Capability | Pi | Ours |
|---|---|---|
| MCP (incl. OAuth) | none | 1,621 lines, port from the fork |
| LSP | none | 3,449 lines, port from the fork |
| Permissions | none | 545 lines, port from the fork |
| Audio / 3D generation | none | in `src/domain`, already here |
| Provider catalog | ~9 providers | 185 providers / 6,583 models |

## Order of work

1. **Platform shims** — done: `paths`, `log`, `version`, `process`.
   `process.spawn` defaults `windowsHide: true` so the console-flash class of
   bug is impossible by construction.
2. **Provider types** — `Info`, `Model`, `ModelID`, `ProviderID`. Decide
   whether to adopt `pi-ai`'s model types or keep our own catalog shape. Our
   catalog is far broader, so likely our own.
3. **CLI agent bridge** — `readCliAgentUsage`, `refreshCliAgentUsage`,
   `CliAgentQuota`. This is the subscription-quota feature
   (Anthropic / Cursor / Codex) and is product-defining. Port from the fork.
4. **Web UI serving** — `embeddedUI` and friends, needed by `runtime-status`.
   Evaluate `pi-server` + `pi-protocol` before porting.
5. **MCP, LSP, permissions** — port wholesale from the fork; Pi has none.
6. **TUI** — the largest single cost. 32,950 lines on OpenTUI in the fork; a
   move here means rebuilding on `pi-tui`. Do this last, and only once
   everything beneath it works.

## Rule

The fork keeps shipping until this repo can replace it. No cutover date.
