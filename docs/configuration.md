# Configuration

CodeGoblin reads configuration from a JSON file, environment variables, and sensible defaults.

## Config file

CodeGoblin looks for, in order of preference:

1. `codegoblin.jsonc` / `codegoblin.json` (project or global)
2. `opencode.jsonc` / `opencode.json` (legacy — still honored for compatibility)

Project config lives at the repo root; global config lives under your config directory
(`~/.config/codegoblin/`). Project values override global ones. You can also keep per-project
extras under a `.codegoblin/` directory (legacy `.opencode/` is still read).

A minimal config:

```jsonc
{
  "$schema": "https://codegoblin/config.json",
  "model": "codegoblin/qwen3-0.6b"
}
```

## Environment variables

CodeGoblin-branded variables take precedence; the legacy `OPENCODE_*` names are read as a
fallback so existing setups keep working. Common ones:

| Variable | Purpose |
|----------|---------|
| `CODEGOBLIN_CONFIG` | Path to an explicit config file |
| `CODEGOBLIN_CONFIG_DIR` | Override the config directory |
| `CODEGOBLIN_MODELS_URL` | Override the models catalog base URL |
| `CODEGOBLIN_DB` | Path to the session database (or `:memory:`) |
| `CODEGOBLIN_RUNTIME_DIR` | Where the local model engine + models live |
| `CODEGOBLIN_RUNTIME_CTX` | Default context window for the local runtime |
| `CODEGOBLIN_DISABLE_AUTOUPDATE` | Turn off update checks |

Run `codegoblin <command> --help` to see flags for a specific command.

## Data locations

| What | Location |
|------|----------|
| Sessions, auth, logs | `~/.local/share/codegoblin/` (override the runtime root with `CODEGOBLIN_RUNTIME_DIR`) |
| Config | `~/.config/codegoblin/` and project `codegoblin.json` / `.codegoblin/` |
| Local model engine + GGUFs | `<runtime>/engine` and `<runtime>/models` |
| Generated assets | `codegoblin-output/` inside the current project |

These paths follow the XDG base-directory conventions for your platform. CodeGoblin adopts an
existing legacy `opencode` data directory automatically on first run (renaming it), so upgrading
preserves your sessions — except databases written by a different/newer tool, which are left
untouched and a fresh one is started.

## Compatibility note

For a transition period, CodeGoblin intentionally still reads the legacy `opencode.json`,
`.opencode/`, and `OPENCODE_*` names. New configuration should use the `codegoblin` / `cg` /
`CODEGOBLIN_*` names.
