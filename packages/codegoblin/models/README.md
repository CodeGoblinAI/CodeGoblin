# CodeGoblin models catalog

This directory holds a **CodeGoblin-owned snapshot** of the provider/model catalog (`api.json`).

## Why

Runtime fetches use `CODEGOBLIN_MODELS_URL` (or the default GitHub raw path here) when `CODEGOBLIN=1`, instead of always depending on upstream OpenCode infrastructure.

Built binaries also embed a catalog snapshot at compile time via `OPENCODE_MODELS_DEV`.

## Sync locally

```bash
bun ./packages/codegoblin/script/sync-models-catalog.ts
```

Optional source override:

```bash
CODEGOBLIN_MODELS_SYNC_URL=https://models.dev/api.json bun ./packages/codegoblin/script/sync-models-catalog.ts
```

Commit `api.json` after reviewing the diff. The weekly GitHub Action keeps this fresh on `dev`.

## Runtime overrides

- `CODEGOBLIN_MODELS_URL` — full catalog base URL (append `/api.json` internally when fetching)
- `CODEGOBLIN_MODELS_PATH` — local file override
- `CODEGOBLIN_DISABLE_MODELS_FETCH=1` — offline mode (embedded/bundled catalog only)

CodeGoblin-native provider models (`codegoblin/deepseek-chat`, image/audio helpers) are defined in `packages/codegoblin/src/codegoblin/provider.ts` and merged separately from this catalog.
