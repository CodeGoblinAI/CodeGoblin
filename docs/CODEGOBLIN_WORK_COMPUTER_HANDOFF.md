# CodeGoblin Work Computer Handoff

Last updated: 2026-05-26.

This file supplements Shawn's local project brain at `C:\Users\shawn\.codex\skills\codegoblin-project-brain\SKILL.md`. It does **not** replace that skill. Future agents should read the project brain first, then this file, then the core repo docs listed below.

## Product north star

CodeGoblin is Shawn's local-first AI command center for building, coding, and generating assets. It started as a fork/customization of OpenCode because OpenCode already provides the right local agent shell, provider routing, BYOK support, sessions, TUI/CLI workflow, auth/connectors, MCP/OAuth behavior, and broad model support. The long-term direction is **OpenCode-style agent shell + ComfyUI-style generation templates + local asset/project management + universal model access**, with CodeGoblin becoming the local shell where code agents, chat models, image/edit/video/voice/3D/local/hosted workflows, model routing, output metadata, and cost/token-hoard awareness can live together.

Keep the product serious first. The goblin is a tasteful mascot and token-hoard metaphor, not a gimmick. Preserve OpenCode's useful internals and legal attribution while replacing unnecessary product-facing OpenCode branding with CodeGoblin.

## Required context read for this handoff

Read in this pass:

- Local project brain: `C:\Users\shawn\.codex\skills\codegoblin-project-brain\SKILL.md`
- `docs/PROJECT_STATE.md`
- `docs/IMPLEMENTATION_LOG.md`
- `docs/KNOWN_ISSUES.md`
- `docs/NEXT_STEPS.md`
- `docs/OPENCODE_ARCHITECTURE_NOTES.md`
- `docs/SECURITY_NOTES.md`
- `UPSTREAM.md`
- `SECURITY.md`

Key source/package files inspected:

- Root and CLI package manifests: `package.json`, `packages/opencode/package.json`
- CLI entrypoints/wrappers: `packages/opencode/src/index.ts`, `packages/opencode/bin/opencode`, `packages/opencode/bin/codegoblin`, `packages/opencode/bin/cg`
- Build/publish/install scripts: `packages/opencode/script/build.ts`, `packages/opencode/script/publish.ts`, `packages/opencode/script/postinstall.mjs`, `packages/script/src/index.ts`
- CodeGoblin modules: `packages/opencode/src/codegoblin/brand.ts`, `packages/opencode/src/codegoblin/provider.ts`, `packages/opencode/src/codegoblin/image-command.ts`, `packages/opencode/src/cli/cmd/image.ts`
- Provider/model routing: `packages/opencode/src/provider/provider.ts`
- Local web/image server routes: `packages/opencode/src/server/routes/instance/httpapi/server.ts`
- Auth/server/MCP surfaces: `packages/opencode/src/server/auth.ts`, `packages/opencode/src/mcp/oauth-callback.ts`, `packages/opencode/src/mcp/oauth-provider.ts`
- TUI: `packages/opencode/src/cli/cmd/tui/app.tsx`, `packages/opencode/src/cli/cmd/tui/routes/home.tsx`, `packages/opencode/src/cli/cmd/tui/component/prompt/index.tsx`, `packages/opencode/src/cli/cmd/tui/routes/session/sidebar.tsx`
- Web app: `packages/app/src/components/prompt-input/submit.ts`, `packages/app/src/components/codegoblin-logo.tsx`, `packages/app/src/i18n/en.ts`, `packages/app/src/desktop-menu.ts`, `packages/app/src/pages/layout/deep-links.ts`, `packages/app/src/pages/layout/helpers.ts`
- UI theme/message surfaces: `packages/ui/src/context/marked.tsx`, `packages/ui/src/theme/context.tsx`, `packages/ui/src/theme/default-themes.ts`, `packages/ui/src/components/message-part.tsx`

## Branch and git snapshot

Inspected with `git fetch origin --prune`, `git status --short --branch`, `git branch --show-current`, `git branch -vv`, `git log`, and `git diff` commands.

- Repository: `C:\Users\shawn\OneDrive\Documents\coding stuff\CodeGoblin`
- Current branch: `feat/codegoblin-local-install`
- Tracking branch: `origin/feat/codegoblin-local-install`
- Base branch for this feature: `origin/dev`
- `origin/dev` at inspection: `f7f603631 chore(opencode): sync CodeGoblin bin lockfile`
- Feature branch head before this handoff pass: `614c69f4f fix(app): use CodeGoblin goblin favicon`
- Commits ahead of `origin/dev` before this handoff pass: `6`
- Expected commits ahead after committing this handoff pass: `7`
- Working tree before this handoff pass: clean
- Local `dev` is stale/diverged: `94b864e8c [origin/dev: ahead 41, behind 43]`; do **not** continue from local `dev` unless intentionally resetting from `origin/dev`.
- Remotes:
  - `origin`: `https://github.com/shawnisikli/CodeGoblin.git`
  - `upstream`: fetches `https://github.com/anomalyco/opencode.git`, push URL is `DISABLED`
- Git identity on this machine: `xerox777777 <shawnxerxes@yahoo.com>`

## Feature branch commit clusters

The feature branch has six commits over `origin/dev` before this handoff pass:

1. `89b962f6b fix(opencode): repair local CodeGoblin shell launch`
   - Updated `packages/opencode/bin/codegoblin` and `packages/opencode/bin/opencode`.
   - Purpose: make local/global shell launch prefer built binaries correctly and avoid the old source-runtime TUI failure path.

2. `c437d723f feat(opencode): add CodeGoblin npm packaging`
   - Added `.github/workflows/publish-codegoblin-npm.yml`.
   - Updated root metadata, README install direction, `bun.lock`, `packages/opencode/script/postinstall.mjs`, `packages/opencode/script/publish.ts`, and `packages/script/src/index.ts`.
   - Purpose: generate/publish `codegoblin` npm installer plus platform packages named `codegoblin-<platform>-<arch>`, with `codegoblin` and `cg` commands.

3. `cd6983848 fix(opencode): embed CodeGoblin web UI in builds`
   - Updated publish workflow and README.
   - Purpose: make release/local build flow embed the CodeGoblin web UI instead of relying on the inherited hosted app fallback.

4. `1b2329018 fix(app): polish CodeGoblin UX copy`
   - Updated web prompt submit, desktop menu, English app copy, runtime boot copy, TUI prompt copy, UI favicon metadata, and `packages/opencode/src/codegoblin/image-command.ts`.
   - Purpose: polish user-facing CodeGoblin labels and improve image-command behavior/messages.

5. `123ee8bd1 fix(opencode): align CodeGoblin runtime labels`
   - Updated flags, run/serve/web/attach labels, TUI keybind default, config service, and server auth.
   - Purpose: add/align `CODEGOBLIN_*` runtime names while preserving `OPENCODE_*` compatibility fallbacks.

6. `614c69f4f fix(app): use CodeGoblin goblin favicon`
   - Imported Shawn's goblin mark into app/browser assets.
   - Updated favicon/manifest/logo files, web logo component, app layout helpers, TUI dialogs/tips/sidebar fallback, UI markdown/theme naming, and implementation/project-state docs.
   - Purpose: make visible web/app assets use Shawn's CodeGoblin goblin mark and remove additional scoped visible OpenCode wording.

This handoff pass adds:

- Root build/link convenience scripts in `package.json`.
- README source-checkout instructions for `npm run build` and `npm run link:local` wrappers.
- Small remaining visible auth/ACP rebrands in MCP callback/OAuth metadata and ACP auth labels.
- This supplemental handoff document.

## Important CodeGoblin-specific files

Core product layer:

- `packages/opencode/src/codegoblin/brand.ts` — product constants, tagline, mascot text, disclaimer.
- `packages/opencode/src/codegoblin/provider.ts` — optional `codegoblin` provider scaffold plus image-model catalog augmentation for OpenAI/Qwen image models.
- `packages/opencode/src/codegoblin/image-command.ts` — local image generation command, image-capable model gating, provider adapters, safe output paths, input image handling, key loading, and usage recording.
- `packages/opencode/src/cli/cmd/image.ts` — shell command `codegoblin image <prompt..>`.
- `packages/opencode/src/server/routes/instance/httpapi/server.ts` — local `POST /codegoblin/image` and `POST /codegoblin/open-output` routes, chat persistence, output-path validation.

Install/package layer:

- `packages/opencode/bin/codegoblin` — local/source/global CodeGoblin launcher.
- `packages/opencode/bin/cg` — short alias wrapper.
- `packages/opencode/bin/opencode` — inherited wrapper still used for built binary discovery.
- `packages/opencode/script/build.ts` — Bun binary build; currently emits binaries under inherited `opencode-*` dist directories, then packaging renames/copies for CodeGoblin.
- `packages/opencode/script/publish.ts` — generates top-level `codegoblin` npm package and native `codegoblin-*` packages.
- `packages/opencode/script/postinstall.mjs` — postinstall copies/resolves native binary into installer package.

TUI/web/UX layer:

- `packages/opencode/src/cli/cmd/tui/routes/home.tsx` — CodeGoblin header variants and optional footer goblin runner.
- `packages/opencode/src/cli/cmd/tui/component/prompt/index.tsx` — TUI prompt interception for `/image`, natural image prompts, pasted image input, token-hoard footer, and text-model image warnings.
- `packages/opencode/src/cli/cmd/tui/app.tsx` — TUI app commands, terminal title, `/goblin*` commands, model/theme/help dialogs.
- `packages/opencode/src/cli/cmd/tui/routes/session/sidebar.tsx` — sidebar footer fallback and optional token goblin.
- `packages/app/src/components/prompt-input/submit.ts` — web prompt interception and optimistic image job messages.
- `packages/app/src/components/codegoblin-logo.tsx` — web logo mark from `/codegoblin-logo.png`.
- `packages/ui/src/components/message-part.tsx` — web/TUI image job card rendering from `metadata.codegoblin`.

Brand assets:

- `packages/app/public/codegoblin-logo.png`
- `packages/app/public/favicon-96x96-v3.png`
- `packages/app/public/favicon-v3.ico`
- `packages/app/public/apple-touch-icon-v3.png`
- `packages/app/public/web-app-manifest-192x192.png`
- `packages/app/public/web-app-manifest-512x512.png`
- `packages/app/public/favicon.svg` and `favicon-v3.svg` as simple fallback marks.

## Upstream/OpenCode inheritance to preserve

Do not globally rename these without a deliberate migration plan:

- Internal package names and imports such as `@opencode-ai/*`.
- Workspace package `packages/opencode` and internal package name `opencode`.
- Durable config/data paths under `.opencode` and app data root `opencode`; this preserves existing sessions/auth/config.
- `OPENCODE_*` env vars and compatibility flags. CodeGoblin now adds `CODEGOBLIN_*` aliases for some user-facing server/auth flows, but the inherited names still matter.
- Provider IDs such as `opencode`, `opencode-go`, and upstream-hosted provider references.
- MCP OAuth callback path `/mcp/oauth/callback` and existing auth storage behavior.
- ACP compatibility IDs such as `opencode-login` where clients may already know the old identifier.
- License, `UPSTREAM.md`, `SECURITY.md`, and attribution references.
- Upstream docs links when explicitly labeled as base/upstream docs.

## Install/build/run flow

Preferred source checkout flow on this Windows machine:

```powershell
cd "C:\Users\shawn\OneDrive\Documents\coding stuff\CodeGoblin"
bun install
$env:PATH='C:\Users\shawn\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin;' + $env:PATH
npm run build
npm run link:local
codegoblin --version
codegoblin --help
cg --help
```

Equivalent lower-level commands:

```powershell
bun run --cwd packages/opencode build --single --skip-install
npm --prefix packages/opencode link
```

Fast CLI/TUI smoke build without embedded web UI:

```powershell
npm run build:cli:fast
```

Do **not** use `--skip-embed-web-ui` for web/server verification, because the binary can fall back to the inherited hosted web app if embedded assets are missing.

Useful smoke commands:

```powershell
codegoblin --version
codegoblin --help
cg image "generate an image of a horse" --dry-run
cg image "generate an image of a horse" --provider openai --model gpt-image-1 --dry-run
cg image "make this goblin red" --provider google --model gemini-2.5-flash-image --input packages/app/public/codegoblin-logo.png --dry-run
cg models codegoblin
```

Expected behavior:

- Bare `cg image ... --dry-run` should fail with an explicit image-model selection warning.
- DeepSeek/text models should not attempt image output.
- Image-capable selections should show provider/model/output path in dry-run output.
- `codegoblin` and `cg` should resolve from shell after `npm run link:local`.

Windows troubleshooting:

- Default Node `v20.11.0` is too old for Vite 7's embedded web build; prepend bundled Node as shown above.
- If `dist\opencode-windows-x64\bin\opencode.exe` cannot be deleted, stop any running `codegoblin serve` / `codegoblin web` process first.
- For hidden process smokes, prefer `%APPDATA%\npm\codegoblin.cmd`; `Start-Process -FilePath codegoblin` can open the PowerShell shim in Notepad.
- Do not run tests from repo root; the root `test` script intentionally exits.

## Image/model-routing behavior

Current behavior to preserve:

- Image generation only routes through image-capable selections.
- Text models like DeepSeek return a local warning and do not receive image prompts.
- `codegoblin image` now requires explicit image-capable `--provider`/`--model`; it should not silently default to Gemini/Nano Banana from the shell.
- Supported/scaffolded image providers: Google Gemini image, xAI Grok Imagine, OpenAI GPT Image, and Qwen/DashScope Wan image/edit.
- Local image input/editing plumbing accepts `--input` paths and data URLs from web/TUI attachments.
- Outputs default under `codegoblin-output/images` inside the current workspace and traversal outside the workspace is rejected.
- Web/TUI image jobs persist local chat metadata with provider/model/output path and render CodeGoblin image job cards.

Future-facing but not complete:

- Video, voice/audio, 3D, local open-weight model workflows, workflow/template chains, and hosted subscription/gateway routing remain product direction, not finished implementation.
- TUI image job cards still need visible manual QA and richer interactive controls comparable to web copy/open/retry.

## UX/UI findings

TUI:

- Home route renders a CodeGoblin header with many selectable variants via `CODEGOBLIN_HEADER_VARIANT`.
- Optional footer runner animation is gated by `CODEGOBLIN_FOOTER_ANIMATION` and runner variant env vars.
- Session sidebar can show a token-goblin animation via `CODEGOBLIN_CHAT_GOBLIN`.
- Prompt footer labels `ctx`, `spent`, and `hoard`; local hoard can read `CODEGOBLIN_TOKEN_HOARD_USD`, `CODEGOBLIN_DEEPSEEK_BALANCE_USD`, `CODEGOBLIN_DEEPSEEK_CREDITS_USD`, or `DEEPSEEK_BALANCE_USD`.
- `/models`, `/themes`, `/goblin`, `/goblin-models`, `/goblin-usage`, and related slash/palette commands are registered in the TUI.

Web:

- Home/new-session surfaces use the Shawn goblin logo mark and CodeGoblin black/green styling.
- Prompt submit intercepts `/image` and image-looking prompts when an image model is selected.
- Web image jobs create optimistic user/progress messages, persist server results, and show provider/model/output path.
- Settings > General includes `Auto-approve image generation`.

Limitations:

- The in-app browser automation bridge failed in a previous pass; direct Playwright/curl smokes were used instead.
- Visible manual TUI QA is still needed for model selection, pasted image input, long-running image progress, and result feel.

## Remaining OpenCode references and why they remain

Categories that should remain for now:

- Legal/upstream attribution: `LICENSE`, `UPSTREAM.md`, `SECURITY.md`, docs explaining CodeGoblin's fork status.
- Internal imports/package IDs: `@opencode-ai/*`, `packages/opencode`, `@opencode/*` service tags.
- Durable compatibility: `.opencode` config dirs, `opencode.db`, localStorage/theme keys, data/cache/state roots.
- Provider compatibility: upstream provider IDs (`opencode`, `opencode-go`) and auth/config schemas.
- Environment compatibility: `OPENCODE_*` flags and server password fallback names.
- Protocol compatibility: MCP callback path and ACP compatibility IDs.
- Upstream hosted links, when labeled as base/upstream docs or upstream hosted provider links.
- Localized strings in non-primary languages still contain inherited OpenCode wording; changing all of them is a separate rebrand/localization pass.

Potential future cleanup:

- ACP README/examples and less-used ACP integration surfaces can be rebranded carefully.
- Desktop feedback/provider upsell/localized strings can be progressively rebranded.
- Durable data-path migration from `opencode` to `codegoblin` requires an explicit migration/compatibility plan.

## Security status and boundaries

Do not commit:

- Real provider keys, Gemini/DeepSeek/OpenAI/xAI/Qwen/DashScope keys, Stripe secrets, PATs, `.env` files, logs, local DBs, generated credentials, or generated user image outputs.

Current safe boundaries:

- `codegoblin` hosted provider is scaffold/mock only.
- Production gateway keys, Stripe logic, private pricing, provider contracts, and enterprise billing logic stay out of the public repo.
- Local image generation writes to disk under the current workspace by default.
- `POST /codegoblin/open-output` validates output paths stay inside the workspace before opening a folder/file.
- Server mode now accepts `CODEGOBLIN_SERVER_PASSWORD` and falls back to `OPENCODE_SERVER_PASSWORD`; bind carefully and set a password for non-loopback use.

Before public release:

```powershell
gitleaks detect --source .
git status --short
git log -p --all
```

## Validation checklist for this branch

Current pass results on Windows, 2026-05-26:

- `git diff --check` passed.
- Editor diagnostics reported no errors for touched docs/code/package files.
- `bun run --cwd packages/opencode typecheck` passed.
- `bun run --cwd packages/ui typecheck` passed.
- `bun run --cwd packages/app typecheck` passed.
- `bun --cwd packages/opencode test test/codegoblin/image-command.test.ts` passed: 4 tests, 0 failures.
- `bun --cwd packages/app test src/components/prompt-input/submit.test.ts` passed as part of the app unit run: 337 tests, 0 failures.
- `npm run build` passed after stopping one stale `opencode` process that was locking `dist\opencode-windows-x64\bin\opencode.exe`.
- Build output version smoke: `0.0.0-feat-codegoblin-local-install-202605262330`.
- `npm run link:local` passed.
- `codegoblin --version`, `codegoblin --help`, and `cg --help` passed.
- Image dry-runs passed:
   - bare `cg image ... --dry-run` produced the expected explicit image-model selection warning.
   - `openai/gpt-image-1` dry-run succeeded.
   - `google/gemini-2.5-flash-image` dry-run with `packages/app/public/codegoblin-logo.png` input succeeded and reported one input image.
- Local server/web smoke passed:
   - `codegoblin serve --hostname 127.0.0.1 --port 49320` started with the expected local password warning.
   - `/` returned 200 and included `<title>CodeGoblin</title>`.
   - `/codegoblin-logo.png` returned 200 `image/png`.
   - `/favicon-96x96-v3.png` returned 200 `image/png`.

Reusable checklist:

Targeted validation from package directories:

```powershell
bun run --cwd packages/opencode typecheck
bun run --cwd packages/ui typecheck
bun run --cwd packages/app typecheck
bun --cwd packages/opencode test test/codegoblin/image-command.test.ts
bun --cwd packages/app test src/components/prompt-input/submit.test.ts
```

Packaged build on Windows:

```powershell
$env:PATH='C:\Users\shawn\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin;' + $env:PATH
bun run --cwd packages/opencode build --single --skip-install
```

Installed command smoke:

```powershell
codegoblin --version
codegoblin --help
cg image "generate an image of a horse" --dry-run
cg image "generate an image of a horse" --provider openai --model gpt-image-1 --dry-run
cg image "make this goblin red" --provider google --model gemini-2.5-flash-image --input packages/app/public/codegoblin-logo.png --dry-run
```

Server/web smoke:

```powershell
codegoblin serve --hostname 127.0.0.1 --port 49320
```

Then check:

- `http://127.0.0.1:49320/`
- `http://127.0.0.1:49320/codegoblin-logo.png`
- `http://127.0.0.1:49320/favicon-96x96-v3.png`
- Page title and visible branding should say CodeGoblin.

## Merge/push guidance

If merging feature branch to `dev`, do not use stale local `dev` directly. Use:

```powershell
git fetch origin --prune
git switch -C dev origin/dev
git merge --no-ff origin/feat/codegoblin-local-install
```

Run targeted validation before pushing. Full monorepo pre-push may still fail on inherited Windows symlink/typecheck issues, especially `packages/enterprise/src/custom-elements.d.ts`. If targeted checks and packaged build pass and the push is blocked only by that known unrelated Windows symlink issue, document it and use `git push --no-verify` for this private checkpoint.

## Must not be overwritten

- Shawn's goblin logo/favicon assets under `packages/app/public`.
- `codegoblin` and `cg` launcher behavior.
- Explicit image-capable model gating in CLI/TUI/web/server paths.
- Local output path validation and `codegoblin-output/images` default.
- Web/TUI image job metadata under `metadata.codegoblin`.
- `CODEGOBLIN_*` server/auth aliases plus `OPENCODE_*` compatibility fallbacks.
- Upstream MIT license and attribution/disclaimer.
- OpenCode provider breadth, BYOK, MCP/OAuth, auth/connectors, session storage, and provider routing.

## Next recommended pass

1. Commit and push this handoff/install/auth-label pass.
2. Run the full targeted validation checklist above, including packaged build and installed command smokes.
3. Visually launch `codegoblin` in a real terminal and inspect TUI home, `/models`, `/goblin`, `/image`, pasted image input, and image loading/result cards.
4. Live-test OpenAI GPT Image and Qwen/DashScope Wan with local keys that are never committed.
5. Continue scoped rebrand in ACP docs/examples, desktop/provider upsell surfaces, localized strings, README expansion, and public attribution/license review docs.
6. Decide later whether durable paths remain OpenCode-compatible or migrate to CodeGoblin-specific paths.