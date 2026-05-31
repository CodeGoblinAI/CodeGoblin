# CodeGoblin UX & Usability Pass — 2026-05-29

This document is the explainer + TLDR for the full usability pass on the features
added recently (image gen, voice gen, memory plan, themes, balance/token cost,
branding, commands/shortcuts). It also lists suggested easy-to-wire features and
next steps.

---

## TLDR

- **`cg update` is fixed.** The installed binary was stale and predated the
  `update` command, so it tried to `cd` into a bogus path. Rebuilt the binary;
  `cg update` / `cg upgrade` now resolve to the real updater.
- **Web voice dialog now has a working Generate button.** The form was taller
  than the 512px dialog and the footer got clipped. The body is now scrollable
  and the footer is pinned, so "Generate audio" is always reachable.
- **TUI audio output is now clickable**, just like images. Generated audio shows
  a card you can click to open/play it instead of copy-pasting a path.
- **Balance refreshes after each turn.** DeepSeek/Moonshot *live* balances now
  refetch shortly after the model goes idle, so the footer updates without
  waiting for the 3-minute timer. (Manual `*_BALANCE_USD` env values are static
  by design — see Token cost approach below.)
- **Themes were already wired** — `codegoblin` is the default in both the TUI and
  the web app. It's now also registered in the shared UI theme map for
  consistency.
- **Commands/shortcuts verified.** All top-level CLI commands register correctly
  and `cg audio --dry-run` plans output without spending credits. ESC-to-end
  logic was intentionally left untouched.

---

## What was fixed this session (detail)

### 1. `cg update` / `codegoblin update`
- **Symptom:** `Error: Failed to change directory to C:\Users\shawn\update`.
- **Root cause:** the global `cg`/`codegoblin` shim prefers the compiled binary
  at `dist/opencode-windows-x64/bin/opencode.exe` over source. That compiled
  binary was built *before* the `update` command existed, so `update` was parsed
  as a positional `[project]` and the TUI tried to open a project named
  `update`.
- **Fix:** rebuilt the binary (`bun run build --single`). Verified
  `node bin/codegoblin update --help` shows the real updater (positional
  `target`, `--method` curl/npm/pnpm/bun/brew/choco/scoop).

### 2. Web voice/audio dialog confirm button
- **Symptom:** "there is no confirm button to proceed with voice gen".
- **Root cause:** `dialog-content` is capped at `max-height: 512px` and
  `dialog-body` is `overflow: hidden`. The audio form (voice, model, format,
  stability, similarity, style, speed, etc.) overflowed and clipped the footer.
- **Fix (`packages/app/src/components/prompt-input.tsx`,
  `confirmAudioGeneration`):** wrapped the fields in a scrollable inner div
  (`overflow-y-auto`, `min-h-0 flex-1`) and pinned the footer
  (`flex-shrink-0 border-t`). The button is always visible now.

### 3. TUI clickable audio output
- **Symptom:** "I want the elevenlabs output to be similar to what we did to
  images where we can click it directly instead of copying and pasting the
  path".
- **Fix (`packages/opencode/src/cli/cmd/tui/routes/session/index.tsx`):** added
  `CodeGoblinAudioMeta` + `codeGoblinAudioMeta()` parser and a
  `CodeGoblinAudioStatusPart` clickable card (mirrors the image card). It calls
  `openCodeGoblinOutputFromTui({ mode: "open" })`, shows voice/format and a
  "click to play" hint. `TextPart` now switches between image / audio / markdown.

### 4. Balance not decrementing fast enough
- **Fix (`packages/opencode/src/cli/cmd/tui/component/prompt/index.tsx`):** in
  addition to the existing 180s refetch, added a `createEffect` that refetches
  the balance ~1.5s after status transitions from active → idle, so the footer
  updates right after a turn.
- See the **Token cost approach** section for why a *manual* `$2.12` value can
  appear static.

### 5. Themes
- `codegoblin.json` exists with a full light+dark palette (green primary
  `#62f56e` dark / `#116b24` light).
- TUI default = `codegoblin` (`context/theme.tsx` — `kv.get("theme",
  "codegoblin")`, and `codegoblin` is in the TUI `DEFAULT_THEMES`).
- Web default = `codegoblin` (`app.tsx` `defaultTheme="codegoblin"`; web loads
  themes via `import.meta.glob("./themes/*.json")`).
- This pass also added `codegoblin` to the shared
  `packages/ui/src/theme/default-themes.ts` `DEFAULT_THEMES` map so it's listed
  consistently everywhere, not only via the glob.

### 6. Memory feature
- `docs/CODEGOBLIN_MEMORY_AND_MODEL_SETTINGS_PLAN.md` is a **planning doc only**.
  The proposed `cg memory status/list/add/...` commands are not implemented yet,
  so there is nothing runtime to test. Next steps below propose the smallest
  first slice.

---

## Branding approach (opencode → codegoblin)

The product is branded **CodeGoblin** in all user-visible surfaces, but several
identifiers are intentionally still `opencode` for compatibility. Rename in
phases; never break the compat surfaces below.

**Keep as-is (compat — do NOT rename):**
- npm package names / scopes: `@opencode-ai/*`, internal package dir name
  `packages/opencode`, global module junction `…/npm/node_modules/opencode`.
- Config + provider IDs: `opencode.json`, `.opencode/`, `OPENCODE_*` env vars,
  provider IDs, and GitHub Action URLs that external users may depend on.

**Already rebranded (user-visible text):** CLI help/describe strings, TUI labels,
web copy, default theme name, output folder `codegoblin-output/`.

**Phased rename plan (when ready):**
1. **Phase A — cosmetic only (done/ongoing):** any remaining user-facing
   "opencode" strings → "CodeGoblin".
2. **Phase B — internal package dir:** rename `packages/opencode` →
   `packages/codegoblin` with a path alias + workspace updates. Higher blast
   radius (imports, turbo, tsconfig paths, build scripts). Do as its own PR.
3. **Phase C — public identifiers:** only if/when we publish under a new scope.
   Requires new npm scope, updated install script, and a compatibility shim that
   still reads `opencode.json`/`OPENCODE_*` so existing users don't break.

Recommendation: stay on Phase A; treat B/C as deliberate, isolated migrations.

---

## Token cost / balance approach

There are **two kinds** of balances merged in the footer
(`packages/opencode/src/codegoblin/balance.ts`, `CodeGoblinBalance.resolve()`):

1. **Live API balances** (DeepSeek, Moonshot): fetched from the provider. These
   **do decrement** as you spend. They refresh on the 180s timer and now also
   ~1.5s after each turn goes idle.
2. **Manual configured balances** via `*_BALANCE_USD` env vars: these are
   **static by design** — a number you set yourself. They never decrement
   because nothing tells them what was spent. If your `$2.12` came from a manual
   env value (or the model's official source doesn't expose a queryable
   balance), it will look "stuck".

The footer shows the balance for `selectedBalanceProvider` (the provider of the
active model). So:
- If you use a model whose provider has **no live balance API**, the footer can
  only show the manual env value (static).
- If you use DeepSeek **through a different route than the official balance API**
  (e.g. an aggregator), the official balance endpoint won't reflect that spend.

**Recommendation / next step:** add a small note in the footer/tooltip
distinguishing "live" vs "manual" balances, and only show a live balance when the
selected provider actually supports the balance endpoint. Optionally add a local
running-cost estimate (sum of token usage × price) as a fallback for providers
without a balance API.

---

## Commands / shortcuts / hotkeys

Verified the rebuilt binary registers all top-level commands:

| Command | Purpose |
| --- | --- |
| `cg [project]` | start the TUI (default) |
| `cg run [message..]` | run with a message |
| `cg web` | start server + open web UI |
| `cg update [target]` | update CodeGoblin (alias `upgrade`) |
| `cg audio [text..]` | ElevenLabs TTS → saved locally |
| `cg image <prompt..>` | image gen → saved locally |
| `cg models [provider]` | list available models |
| `cg debug` | troubleshooting tools |

`cg audio` flags: `--voice`, `--list-voices`, `--model`, `--output-format`,
`--stability`, `--similarity-boost`, `--style`, `--speed`, `--speaker-boost`,
`--language-code`, `--seed`, `--text-normalization`,
`--language-text-normalization`, `--key-file`, `--dry-run`. To set a voice in the
CLI: `cg audio "text" --voice <id>` (discover IDs with `cg audio --list-voices`).

`cg audio "hello goblin" --dry-run` was verified to plan output (no credits
spent). **ESC-to-end-message logic was intentionally left untouched.**

---

## Suggested easy-to-wire features (next, low effort)

1. **`cg audio --voice` persistence:** save the last-used voice id to KV so the
   CLI and web default to it instead of the account's auto voice.
2. **Balance source label:** tag the footer balance as `live`/`manual` and hide
   live balances for providers without a balance endpoint (small change in
   `balance.ts` + footer formatter).
3. **Web: remember audio/image settings:** persist the last dialog settings
   (voice, model, format) in localStorage so users don't re-pick every time.
4. **`cg open` shortcut:** open the most recent generated output
   (image/audio) from the CLI without a path.
5. **Local cost estimate fallback:** running USD estimate from token usage for
   providers with no balance API.

## Next steps (bigger)

- **Memory feature slice 1:** implement read-only `cg memory list` + `cg memory
  status` against the existing SQLite store before the write commands.
- **Branding Phase B:** isolated PR to rename `packages/opencode` →
  `packages/codegoblin` with aliases, keeping all compat surfaces.

## Idea jots (future — explicitly NOT now)

- Use Hermes' agentic capabilities in a separate "mode".
- Add 1 unique model for testing (e.g. a 3D asset generator).
- Work with local models + cloud GPUs down the line.

---

# Follow-up pass — spend, animation, memory, open (2026-05-29 cont.)

This section covers the second implementation pass.

## Done & tested

### 1. Spend accumulation now includes image/audio
- **Symptom:** footer/companion showed `$0.00` even after a nanobanana image
  generation estimated at `$0.039`.
- **Root cause:** image/audio costs live on *synthetic assistant messages* and
  are not always folded back into `session.cost`. Both the companion
  (`sidebar.tsx`) and the prompt footer (`prompt/index.tsx`) read only
  `session().cost`.
- **Fix:** spend is now `max(session.cost, sum(assistant message costs))`, so
  image/audio spend shows up in the footer/companion.

### 2. Companion burn animation
- The companion already defaults to header variant `09`, sprite `40`, action
  variant `03` (the `dev:companion:03` coin-toss) and only triggers on real
  positive cost/token deltas (the `CODEGOBLIN_COMPANION_PREVIEW` loop is
  dev-only). The reason the animation "never" played for image gen was the spend
  bug above — no delta meant no burn. With spend fixed, the burn animation now
  fires on real image/audio spend.

### 3. Balance source label + running-cost fallback
- Footer balance is now tagged `· live` (DeepSeek/Moonshot API) or `· manual`
  (`*_BALANCE_USD` env). For providers without a balance endpoint, the footer
  falls back to a `~$X spent` running estimate. Covered by `balance.test.ts`.

### 4. `cg memory list` + `cg memory status` (read-only, SQLite)
- New `memory_entry` table (Drizzle migration `..._add_memory_entry`) plus
  `CodeGoblinMemory` repo (`src/codegoblin/memory.ts`) and CLI command
  (`src/cli/cmd/memory.ts`). Read-only slice 1: `cg memory list [--scope]
  [--project] [--all] [--json]` and `cg memory status [--json]`. Write commands
  (`add`/`replace`/`remove`/`review`) come later. Covered by `memory.test.ts`.

### 5. `cg open`
- `cg open [target] [--folder] [--reveal]` opens the most recent file under
  `codegoblin-output/` (or a specific project-relative path). Reuses the same
  path-confinement + platform-open behavior as the server's
  `openCodeGoblinOutput`.

## Deferred (with rationale)

### `/audio` and `/image` in-app settings persistence
- These slash commands **do not exist yet** in the TUI (image gen is currently
  driven by selecting an image model and prompting). Persisting "last-used"
  settings requires first building the settings dialogs. That is net-new UI and
  was not built blind in this pass to avoid speculative scope. Next step: add
  `/audio` and `/image` dialogs, then persist voice/model/format via the TUI KV
  store (`useKV`, `Global.Path.state/kv.json`).

### Web: remember audio/image settings (localStorage)
- The web app (`packages/app`) has **no audio/image generation dialog** today, so
  there is nothing to persist yet. Wire this once the web dialogs exist, using
  the existing `localStorage` persistence helpers in `src/utils/persist.ts`.

### Branding Phase B (`packages/opencode` → `packages/codegoblin`)
- A full directory rename touches hundreds of imports, `turbo.json`,
  `tsconfig`, the custom build, and the `bin` wrappers. Doing that blind while
  unattended (with a flaky pre-push hook and a compiled-binary build path) is
  high-risk and hard to reverse. **Recommendation:** do it as a dedicated,
  attended PR. Keep all compat surfaces (`@opencode-ai/*`, `opencode.json`,
  `.opencode`, `OPENCODE_*`, provider IDs, GitHub action URLs); only the
  directory + internal package name change, with a path alias for the old name.

---

# UX pass — media settings + phase check (2026-05-31)

This pass revisits the deferred UX items now that the web image/audio flows and
image re-roll actions exist.

## Done in this pass

1. **Web audio settings are remembered and can be auto-approved.** The audio
   dialog already persists voice, format, normalization, and tuning in browser
   localStorage; this pass added a first-class Settings > General switch for
   **Auto-approve audio generation**, which reuses those saved settings and skips
   the confirmation dialog.
2. **Image result actions are more explicit.** The completed image card now uses
   labeled buttons for **Re-roll**, **3 variants**, and error-state **Retry
   image** instead of icon-only actions.
3. **Phase-A copy polish.** Updated the desktop Help menu to point at the live
   CodeGoblin UX plan instead of a removed project-state file, and removed a
   stray settings console log.

## Phase check

- **Phase A — cosmetic/user-visible polish:** continued. Safe user-facing copy
  and action labels were improved without touching compatibility identifiers.
- **Phase B — internal package directory rename:** still deferred. This remains a
  dedicated migration PR because it touches workspace/package/build paths.
- **Phase C — public identifiers/scope rename:** still deferred until a new
  publish scope and compatibility shim are intentionally planned.

## Still worth doing next

- Add provider-specific media presets so image/audio settings can be saved per
  provider/model rather than globally.
- Surface the active saved audio voice/format in the model selector or prompt
  footer when an audio model is selected.
- Keep Phase B/C as separate, attended migrations; do not mix them into feature
  UX passes.

