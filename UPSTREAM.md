# Upstream

CodeGoblin builds on OpenCode's MIT-licensed codebase. It is an independent fork/customization and is not affiliated with OpenCode, Anomaly, or their maintainers.

## Upstream Details

- Upstream repository: `https://github.com/anomalyco/opencode`
- Historical redirect checked: `https://github.com/sst/opencode` redirects to `anomalyco/opencode`
- Upstream default branch at fork time: `dev`
- Fork date: 2026-05-24
- Fork-start commit: `47f333299bb193f28dfdd94ccc43e55c529198ee`
- Upstream license: MIT
- Upstream copyright notice: `Copyright (c) 2025 opencode` (preserved in LICENSE and NOTICE)

## What stays OpenCode-named

Compatibility surfaces are intentionally preserved until a dedicated migration provides aliases, data migration, and release notes. Examples:

- Config files: `opencode.json`, `opencode.jsonc`, `.opencode/`
- Environment variables: `OPENCODE_*` (with `CODEGOBLIN_*` preferred for new CodeGoblin-specific flags)
- Provider IDs: `opencode`, `opencode-go`, and related upstream-hosted provider integrations
- Internal API/type names where renaming would break extensions or stored data

See `docs/OPEN_SOURCE_BOUNDARIES.md` for the full list.

## Attribution

CodeGoblin preserves OpenCode's MIT license notice and upstream history. Keep OpenCode references where required for license, attribution, and compatibility documentation.

## Remotes

Local remotes after setup:

```bash
origin   https://github.com/shawnisikli/CodeGoblin.git
upstream https://github.com/anomalyco/opencode.git
```

The local `upstream` push URL is set to `DISABLED` to prevent accidental pushes to upstream.

## Pulling Upstream Changes

```bash
git fetch upstream
git switch dev
git merge upstream/dev
```

Resolve conflicts by preserving CodeGoblin product changes while keeping upstream provider/auth/storage behavior unless a deliberate CodeGoblin decision says otherwise.

## Pushing CodeGoblin

```bash
git push -u origin dev
```

## Public disclaimer (when needed)

> CodeGoblin is an independent fork/customization of OpenCode and is not affiliated with OpenCode, Anomaly, or their maintainers.
