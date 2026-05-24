# Upstream

CodeGoblin is an independent fork/customization of OpenCode.

CodeGoblin is not affiliated with OpenCode, Anomaly, or their maintainers.

## Upstream Details

- Upstream repository: `https://github.com/anomalyco/opencode`
- Historical redirect checked: `https://github.com/sst/opencode` redirects to `anomalyco/opencode`
- Upstream default branch at fork time: `dev`
- Fork date: 2026-05-24
- Fork-start commit: `47f333299bb193f28dfdd94ccc43e55c529198ee`
- Upstream license: MIT
- Upstream copyright notice in `LICENSE`: `Copyright (c) 2025 opencode`

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

## Public Disclaimer

Use this wording in public-facing docs:

> CodeGoblin is an independent fork/customization of OpenCode and is not affiliated with OpenCode, Anomaly, or their maintainers.
