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
bun run --cwd packages/opencode build --single --skip-embed-web-ui --skip-install
cd packages/opencode
npm link
codegoblin --help
cg --help
```

On Windows, if native dependency install scripts fail in a local checkout, this lighter setup is often enough for CLI smoke testing:

```bat
bun install --ignore-scripts
set MODELS_DEV_API_JSON=%CD%\packages\opencode\test\tool\fixtures\models-api.json
bun run --cwd packages/opencode build --single --skip-embed-web-ui --skip-install
```

## Image dry run

```bash
codegoblin image "small goblin mascot coding" --provider openai --model gpt-image-1 --output codegoblin-output/images/dryrun-openai.png --dry-run
```

Image outputs default under `codegoblin-output/images` inside the current project/worktree. CodeGoblin rejects output traversal outside the project root.

## Development

Useful package-level commands:

```bash
bun run --cwd packages/opencode typecheck
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
