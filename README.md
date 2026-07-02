# CodeGoblin

Your local AI goblin for code, images, and agents.

CodeGoblin is a local-first AI coding agent with a terminal UI, web UI, and BYOK provider support. It keeps prompts, sessions, and generated assets on your machine by default, and adds goblin-branded workflows for image generation, local asset output, and simpler installation.

## Documentation

Full guides live in [`docs/`](docs/README.md):

- [Getting started](docs/getting-started.md)
- [Local models](docs/LOCAL_RUNTIME.md) — run small models on your own GPU/CPU
- [Configuration](docs/configuration.md)
- [Providers & models](docs/providers.md)
- [Image, audio & 3D](docs/media.md)
- [Themes](docs/themes.md)

## Install

```bash
npm install -g @codegoblin-io/codegoblin
```

After install:

```bash
codegoblin --help
codegoblin
cg --help
```

The `codegoblin` npm package installs a small launcher plus the native binary package for your platform. `cg` is included as a short alias.

Publish and dry-run via GitHub Actions → **publish-codegoblin-npm** on `CodeGoblinAI/CodeGoblin`.

## Run from a source checkout

This repo uses Bun internally.

```bash
bun install
npm run build
npm run link:local
codegoblin --help
cg --help
```

`npm run build` wraps `bun run --cwd packages/codegoblin build --single --skip-install`. Bun is still the package manager for dependencies.

On Windows, the embedded web build may need a newer Node first on `PATH`:

```powershell
# Put a recent Node 20+ first on PATH (any install location), then build:
$env:PATH = "C:\path\to\node-20+\bin;" + $env:PATH
npm run build
```

For quick CLI/TUI smoke tests only, `--skip-embed-web-ui` is available. Do **not** use it for public `codegoblin web` builds: without embedded CodeGoblin web assets the compatibility fallback can proxy the browser UI through an upstream web host.

On Windows, if native dependency install scripts fail in a local checkout:

```bat
bun install --ignore-scripts
set MODELS_DEV_API_JSON=%CD%\packages\codegoblin\test\tool\fixtures\models-api.json
bun run --cwd packages/codegoblin build --single --skip-embed-web-ui --skip-install
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
bun run --cwd packages/codegoblin typecheck
npm run typecheck:codegoblin
npm run build
bun run --cwd packages/codegoblin build --single --skip-install
bun run --cwd packages/codegoblin build --single --skip-embed-web-ui --skip-install
bun run --cwd packages/codegoblin script/publish.ts --dry-run
```

Backend route coverage (isolated DB, safe for CI):

```bash
bun run --cwd packages/codegoblin test:httpapi
bun run --cwd packages/codegoblin script/httpapi-exercise.ts --mode coverage --fail-on-missing --fail-on-skip
```

Do not run tests from the repo root; use package directories such as `packages/codegoblin`.

## npm packaging notes

The CodeGoblin npm package is generated from `packages/codegoblin/script/publish.ts`:

- top-level package: `codegoblin`
- commands: `codegoblin`, `cg`
- native package prefix: `codegoblin-<platform>-<arch>`
- native postinstall config is stored in generated package metadata

Some internal paths and compatibility identifiers still use OpenCode names where broad renames would break existing configs. User-facing install and command surfaces prefer CodeGoblin names.

## Themes

CodeGoblin ships a goblin-green theme and supports switching and customizing the look in the TUI
and web UI. See [docs/themes.md](docs/themes.md).

## Attribution

CodeGoblin builds on OpenCode's MIT-licensed architecture. It is an independent fork/customization of [OpenCode](https://github.com/anomalyco/opencode) and is not affiliated with OpenCode, Anomaly, or their maintainers.

See also:

- `NOTICE`
- `UPSTREAM.md`
- `docs/OPEN_SOURCE_BOUNDARIES.md`
- `SECURITY.md`
