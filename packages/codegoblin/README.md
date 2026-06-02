# CodeGoblin CLI

Local AI coding agent — terminal UI, web UI, BYOK providers, and CodeGoblin image workflows.

## Commands

```bash
codegoblin          # interactive TUI
codegoblin web      # local web UI
codegoblin image    # image generation with local output paths
cg                  # short alias
```

## Development

```bash
bun install
bun run typecheck
bun test
bun run test:httpapi
bun run build --single --skip-install
```

Publish dry-run:

```bash
bun run script/publish.ts --dry-run
```

See the repository root `README.md` for install, attribution, and open-source boundaries.
