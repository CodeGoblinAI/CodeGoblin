# Local models (Ollama / LM Studio)

CodeGoblin can run against models hosted locally on your own machine — no cloud key, no per-token cost. This is the local-first path for small models (Gemma, Qwen, Llama, etc.).

## Quick start (Ollama)

1. Install [Ollama](https://ollama.com) and start it (it serves on `http://127.0.0.1:11434`).
2. Pull a small model:
   ```bash
   ollama pull gemma2:2b
   ```
3. Confirm CodeGoblin sees it:
   ```bash
   codegoblin status
   # Local models (ollama): gemma2:2b · http://127.0.0.1:11434
   ```

## LM Studio

Start LM Studio's local server (Developer tab → Start server). It exposes an OpenAI-compatible
endpoint on `http://127.0.0.1:1234`. `codegoblin status` will list any loaded models.

## Overriding the endpoints

Discovery checks the default ports, or these environment variables when set:

| Runtime   | Variable                              | Default                   |
|-----------|---------------------------------------|---------------------------|
| Ollama    | `CODEGOBLIN_OLLAMA_URL` / `OLLAMA_HOST` | `http://127.0.0.1:11434`  |
| LM Studio | `CODEGOBLIN_LMSTUDIO_URL`             | `http://127.0.0.1:1234`   |

`codegoblin status --json` includes a `localModels` array with each runtime's `available` flag,
`baseURL`, and discovered `models`.

> Discovery is a short, timed probe — if no runtime is listening, `status` simply reports
> "none detected" and moves on. It never blocks startup, the TUI hub, or health checks.

## Roadmap

This pass adds **detection and the `status` surface**. Making local models selectable in `/models`
and the web model picker (via the OpenAI-compatible provider path) is the next slice.
