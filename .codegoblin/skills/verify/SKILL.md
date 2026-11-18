---
name: verify
description: Boot, test, and verify CG-Next changes end-to-end across typecheck, unit/property/differential tests, dependency audit, compiled binary, TUI PTY, and headless browser passes. Use before committing or declaring any CG-Next task complete.
---

# Verifying CG-Next Changes (`/verify`)

Run cheap checks first, then exercise the real running app on every surface your change touched. Never weaken an assertion, skip a test, or add sleeps to hide a flake; if a check still fails after **3 repair rounds**, stop and escalate to Shawn with the exact failure and what you tried.

## Safety & Sandbox Rules (Non-Negotiable)
- **Never** touch the real `~/.local/share/codegoblin` profile or port `8787` (the 0.3 fork's runtime). Always set `CODEGOBLIN_DIR` (or `XDG_*` in user passes) to an isolated temp/output folder.
- **Never** use permanent delete commands (`rm -rf`, `rd /s /q`, `del`, `Remove-Item -Recurse -Force`); send project scratch cleanups to the Windows Recycle Bin only.
- **Never** run `bun test` bare (it matches `_RECOVERED_LOCAL_2026-08-29/`). Always run `bun run test`.

## 1. Cheap Checks First (Always Run)

```powershell
bun run typecheck
bun run test
bun audit
```

- `bun run test` includes unit tests, seeded property tests (`test/properties.test.ts`), and 0.3/surface differential tests (`test/differential-fork.test.ts`).
- Check `REVIEW.md` (read from `git show HEAD:REVIEW.md`) for any diff-triggered reliability items matching `git diff --name-only`.

## 2. Targeted End-to-End Surface Verification

Run the user passes in `test/user-pass/` **one at a time** (parallel PTY/Chromium load causes false timing flakes) for every area touched. Note: on Windows, `pass-*.mjs` scripts that call `process.kill(process.pid)` to drop open `node-pty` handles exit with code `1` even on success — check stdout for `all passed` and zero `^FAIL ` lines.

- **CLI / Packaging / Compiled Binary** (`src/cli/`, `script/build.ts`, `npm/`, workers):
  ```powershell
  bun run build
  node test/user-pass/pass-binary.mjs
  node test/user-pass/pass-install.mjs
  ```
- **TUI Rendering, Word-Wrap, Dialogs, Approvals, Scrolling, Selection** (`src/tui/`, `terminal-safe.ts`, `permission.ts`, `commands.ts`):
  ```powershell
  node test/user-pass/pass-ux-chaos.mjs
  node test/user-pass/pass-small.mjs
  node test/user-pass/pass-scroll.mjs
  node test/user-pass/pass-approval-shown.mjs
  node test/user-pass/pass-approval-typing.mjs
  node test/user-pass/pass-warm-start.mjs
  ```
  For visual TUI changes, also drive a real Windows Terminal window via `node test/user-pass/tui-window.mjs` + `powershell.exe -File test/user-pass/real-terminal.ps1` and inspect the captured PNGs directly.
- **Web App & Loopback Server** (`src/web/`, `sessions.ts`, `jobs.ts`, `commands.ts`):
  ```powershell
  node test/user-pass/pass-ux-chaos.mjs
  node test/user-pass/pass-web-inputs.mjs
  node test/user-pass/pass-two-windows.mjs
  node test/user-pass/pass-background-web.mjs
  ```
- **0.3 Fork Coexistence & Rollback** (`paths.ts`, `auth.ts`, `fork-import.ts`):
  ```powershell
  bun test/user-pass/real-rollback.ts
  ```
