# CG-Next Code Review & Reliability Rules

> **Reviewer rule:** Always read `REVIEW.md` from the **base ref** (`git show HEAD:REVIEW.md` for uncommitted work, or `git show <merge-base>:REVIEW.md` for a branch/PR) — **never** from the working tree or PR diff under review. A change must never modify the check that judges it.

## Severity Tags

Tag every finding in `/review` output with one of:
- **`[Important]`** — Must-fix correctness bug, security boundary bypass, data loss, hang/leak, or regression.
- **`[Nit]`** — Minor clarity or edge improvement that does not break user flows or safety.
- **`[Pre-existing]`** — Real issue in surrounding code that predated this diff; do not block or blame the diff author for it.

Every finding must cite `file:line` and a concrete input or scenario that triggers it.

---

## Diff-Triggered Reliability Checklist

Check **only** the items whose **Trigger** matches files or concepts touched in the diff:

1. **Session & undo schema compatibility**
   - *Trigger:* `src/core/sessions.ts`, `src/core/undo.ts`, `src/core/agent.ts` (`Message`, `Session`, `ReviewState`, `Checkpoint`)
   - *Check:* Do older `~/.local/state/codegoblin/sessions/*.json` files missing the new field still load, display, compact, `/fork`, `/export`, and `/undo` without throwing? Are `Checkpoint.after` hashes backward-compatible?
   - *Why:* Real user sessions persist across versions and are shared across windows.

2. **Shared state folder with CodeGoblin 0.3 fork**
   - *Trigger:* `src/platform/paths.ts`, `src/core/auth.ts`, `src/core/fork-import.ts`, `src/core/local-runtime.ts`
   - *Check:* Does CG-Next leave `codegoblin.db`, `kv.json`, `runtime.json` (port 8787), and `prompt-history.jsonl` strictly untouched/read-only? Are file writes atomic (`replaceFile` / `writeFileWhole`) with `0o600` / Windows owner ACLs on `auth.json`?
   - *Why:* Both 0.3 and 0.4 share `~/.local/share/codegoblin` so users can roll back cleanly (`real-rollback.ts`).

3. **Consent stays in the loop, and secret files always ask**
   - *Trigger:* `src/core/permission.ts`, `src/core/secret-files.ts`, `src/core/tools.ts`, `src/core/patch.ts`
   - *Check:* Does consent remain in `agent.ts` / `permission.ts` rather than buried inside individual tools? In `full` mode, outside-project commands are allowed without prompting, **except** secret files (`.env`, `auth.json`, `.ssh`, NTFS `:$DATA` streams, trailing dots/spaces, Windows 8.3 short names like `ENV~1`, and `cmd.exe` `^` caret escapes like `.e^nv`) and `codegoblin.jsonc` `deny`/`ask` rules, which must hold in every mode.

4. **Windows `cmd.exe`, encoding, and reserved names**
   - *Trigger:* `src/platform/process.ts`, `src/core/jobs.ts`, `src/core/tools.ts`, `src/core/text-edit.ts`
   - *Check:*
     - `windowsHide: true` is always set on child spawns; `cmd.exe` uses `/d /s /c "..."` with `windowsVerbatimArguments: true` and `chcp 65001>nul 2>&1`.
     - Multi-line shell commands: unquoted lines join cleanly (`&`, skipping `rem`/`::`), and quoted newlines on `win32` fail loudly rather than letting `cmd.exe /c` truncate after line 1 with exit code 0.
     - `PYTHONIOENCODING=utf-8` and `PYTHONUTF8=1` are set unless the user overrode them.
     - `decodeText` / `encodeText` / `undo` preserve UTF-8, UTF-8 BOM, UTF-16LE, UTF-16BE, CRLF, and arbitrary 0-NUL binary headers (PNG, MP3 `0xff 0xfe`, UTF-32LE) byte-for-byte.
     - File writes block Windows device names (`CON`, `NUL`, `COM1`..), trailing dots/spaces, and NTFS `:` streams.

5. **Terminal & approval spoofing**
   - *Trigger:* `src/core/terminal-safe.ts`, `src/tui/**`, `src/web/app.js`
   - *Check:* Untrusted text passes through `visibleControls` on ingress and `frameSafe` on TUI output (pure SGR only; no conceal `8` / `08`, no OSC 52/0, no cursor/clear codes). Approval prompts pass through `askedFor` (`visibleCall`) so bidi overrides (`<U+202E>`) and control codes cannot hide or reorder commands, and mid-draft approvals preserve the user's draft with typing grace.

6. **Network & SSRF bounds**
   - *Trigger:* `src/core/webfetch.ts`, `src/web/serve.ts`, `src/core/providers.ts`, `src/core/catalog.ts`
   - *Check:* `webfetch` pins its socket connection to the exact DNS-resolved IP it checked (`pinnedFetch`, closing the DNS-rebinding window), checks every redirect hop, blocks IPv4/IPv6 private/loopback/NAT64/6to4/Teredo/multicast addresses, and caps both wire and decompressed bytes. Web `/api/*` enforces loopback + `Origin` + `Sec-Fetch-Site`, and `/api/file` stays confined to `codegoblin-output/`.

7. **TUI and Web parity & UX layout invariants**
   - *Trigger:* `src/tui/**`, `src/web/**`, `src/core/commands.ts`, `src/core/command-rank.ts`, `src/core/prompt-commands.ts`
   - *Check:*
     - Every command in `COMMANDS`, `COMMAND_ALIASES`, and `PENDING_COMMANDS` has a working handler in both TUI and Web UI (verified by `pass-ux-chaos.mjs`).
     - Composer word-wrapping (`layoutComposer`) never splits a word across lines when it fits `width`, maps UTF-16 surrogate pairs and 2-cell glyphs accurately for cursor/mouse clicks, and navigates wrapped/multi-line rows on `Up`/`Down` before recalling history (preserving unsent multi-line drafts).
     - Spend & context readouts (`formatStatusBar` in TUI, `#usage-readout` in Web UI) never clip dollar/cent digits (`$0.0…`) or overlap long model names / session titles at narrow widths.
     - TUI `dialogRowAt` accounts for `filterable: true`'s `⌕ type to search` row (`header = 4` vs `3`), and `holdRow` lifts unfolded answers/tools near the bottom of the viewport into view while keeping folded rows under the cursor.
     - Web UI live-stream append helpers (`turn("agent")`, `thinkingBlock`, `toolChip`, `workedLine`) capture `const stick = atBottom()` *before* mutating `#thread` so scrolled-up readers are never yanked down, and `makeDialog` closes on the first `Escape` even when `<input type="search">` has text.
     - In `src/web/app.js`, startup code must never read `let` bindings declared lower down in the file; in `src/tui/width.ts`, `wrapToWidth` must terminate on 2-column glyphs even at `max = 1`.

8. **Compiled Bun binary (`codegoblin.exe`)**
   - *Trigger:* `script/build.ts`, `src/cli/main.ts`, `src/platform/self.ts`, `src/core/voice-engine.ts`, worker files
   - *Check:* Native add-ons are loaded by absolute path (`createRequire(entry)(entry)`), embedded web assets use `with { type: "file" }`, and internal workers (`__reaper`, `__voice-worker`, `__cursor-worker`) route through `cli/main.ts` (`import.meta.main` is false for worker modules inside the compiled binary).

9. **Provider spend & runaway protection**
   - *Trigger:* `src/core/agent.ts`, `src/core/context.ts`, `src/core/refuseless.ts`, `src/core/stall.ts`
   - *Check:* Running-total stream usage (`usageSince`) prices cumulative usage minus prior billed cost so cache discounts aren't lost; `storedSecrets` redacts keys from all tool output/exports; silent cloud streams warn from 20 s and abort at 5 min while local models never time out.
