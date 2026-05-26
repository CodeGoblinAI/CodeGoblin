# CodeGoblin

Your local AI goblin for code, images, and agents.

CodeGoblin is an independent fork/customization of OpenCode and is not affiliated with OpenCode, Anomaly, or their maintainers. It preserves the OpenCode-style local agent architecture while adding CodeGoblin branding, image-generation workflows, local asset output paths, and a path toward simpler end-user installation.

## Install

The intended public npm install path is:

```bash
npm install -g codegoblin
```

After install:

```bash
codegoblin --help
codegoblin
cg --help
```

The `codegoblin` npm package is wired to install a small launcher plus the native binary package for your platform. The short `cg` command is included as an alias.

> The npm package wiring is being prepared on the CodeGoblin local-install branch. Until a release is published, use the source checkout flow below.

## Run from a source checkout

This repo uses Bun internally.

```bash
bun install
npm run build
npm run link:local
codegoblin --help
cg --help
```

`npm run build` is a convenience wrapper around `bun run --cwd packages/opencode build --single --skip-install`; Bun is still the package manager for dependencies.

On Windows, the embedded web build may need a newer Node first on `PATH`:

```powershell
$env:PATH='C:\Users\shawn\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin;' + $env:PATH
npm run build
```

If you only need quick CLI/TUI smoke tests, `--skip-embed-web-ui` is still available. Do **not** use it for `codegoblin web` builds: without embedded web assets the binary proxies the browser UI through `https://app.opencode.ai`, which can be blocked by corporate filters even though the local server still runs on `127.0.0.1`.

On Windows, if native dependency install scripts fail in a local checkout, this lighter setup is often enough for CLI smoke testing:

```bat
bun install --ignore-scripts
set MODELS_DEV_API_JSON=%CD%\packages\opencode\test\tool\fixtures\models-api.json
bun run --cwd packages/opencode build --single --skip-embed-web-ui --skip-install
```

For a Windows build that supports `codegoblin web`, drop `--skip-embed-web-ui` from that last command.

## Image dry run

```bash
codegoblin image "small goblin mascot coding" --provider openai --model gpt-image-1 --output codegoblin-output/images/dryrun-openai.png --dry-run
```

Image outputs default under `codegoblin-output/images` inside the current project/worktree. CodeGoblin rejects output traversal outside the project root.

## Development

Useful package-level commands:

```bash
bun run --cwd packages/opencode typecheck
npm run typecheck:codegoblin
npm run build
bun run --cwd packages/opencode build --single --skip-install
bun run --cwd packages/opencode build --single --skip-embed-web-ui --skip-install
bun run --cwd packages/opencode script/publish.ts --dry-run
```

Do not run tests from the repo root; use package directories such as `packages/opencode`.

## npm packaging notes

The CodeGoblin npm package is generated from `packages/opencode/script/publish.ts`:

- top-level package: `codegoblin`
- commands: `codegoblin`, `cg`
- native package prefix: `codegoblin-<platform>-<arch>`
- native postinstall config is stored in generated package metadata

The internal workspace still contains OpenCode-compatible package names and paths where broad renames would be risky. User-facing install and command surfaces should prefer CodeGoblin names.

## Attribution

CodeGoblin builds on OpenCode's MIT-licensed architecture. Preserve legal attribution and compatibility notes when changing inherited internals.

See also:

- `UPSTREAM.md`
- `docs/PROJECT_STATE.md`
- `docs/SECURITY_NOTES.md`
