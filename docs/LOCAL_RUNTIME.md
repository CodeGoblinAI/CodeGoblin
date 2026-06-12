# CodeGoblin local runtime (first-party inference)

CodeGoblin ships its **own** on-device inference runtime rather than depending on Ollama or
LM Studio. It bundles a prebuilt [llama.cpp](https://github.com/ggml-org/llama.cpp) engine that
the `codegoblin-native` Rust sidecar supervises, serving the OpenAI-compatible HTTP API the
`codegoblin` provider already targets (`http://127.0.0.1:8787/v1`).

## Quick start

```bash
codegoblin runtime install        # one-time: download the llama.cpp engine (CUDA when an NVIDIA GPU is present)
codegoblin runtime pull qwen3-0.6b
```

That's it — pick the model in the TUI/web model selector (local GGUFs appear under a dedicated
**Local models** group, named `<id> (local)`) and chat. The runtime **starts automatically** on
your first message, and **swaps automatically** when you pick a different local model (one model
owns the GPU at a time; the first message after a switch waits a few seconds for the load).
Generation runs on your GPU/CPU; nothing leaves your machine.

Models are discovered by folder scan, ComfyUI-style: drop any `*.gguf` into
`<runtime>/models/` and it appears in the picker named after the file. `runtime pull` is just a
convenience downloader for the curated catalog.

Manual control when you want it: `codegoblin runtime start [--ctx N]` (foreground),
`codegoblin runtime stop`, `codegoblin runtime status`, `codegoblin runtime list`.

## Architecture

```
codegoblin (TUI/web)
   │  OpenAI-compatible HTTP (:8787/v1)
   ▼
codegoblin runtime start            (TS CLI: packages/codegoblin/src/cli/cmd/runtime.ts)
   └─► codegoblin-native llama      (Rust supervisor: packages/codegoblin-native/src/llama.rs)
         └─► llama-server           (bundled prebuilt llama.cpp engine, GPU offload)
```

- The engine installs to `<data>/runtime/engine` — `<data>` is `~/.local/share/codegoblin`
  (legacy `opencode` data dirs are adopted automatically on first run; override the runtime root
  with `CODEGOBLIN_RUNTIME_DIR`). Models live in `<runtime>/models/*.gguf`
  (`CODEGOBLIN_MODELS_DIR`).
- `runtime install` resolves the latest llama.cpp release and picks the asset for this
  platform/acceleration (lowest CUDA version for driver compatibility; CPU build otherwise —
  force with `CODEGOBLIN_RUNTIME_ACCEL=cpu|cuda`).
- The selected model + port + context + supervisor pid persist in `<runtime>/runtime.json`. The
  `codegoblin` provider reads it so the picker and the agent's context handling match the running
  server, and the auto-start/swap manager (`local-runtime-manager.ts`) uses the pid to stop
  exactly its own process tree when switching models — it never kills by port match. A server it
  didn't start (no tracked pid) is reported as a conflict instead of killed.

## Context window

The runtime starts llama-server with a 32768-token context by default (the trained context of
the catalog models — do not exceed a model's trained context). Override per start with
`codegoblin runtime start --ctx 16384` or `CODEGOBLIN_RUNTIME_CTX` (lower it if VRAM is tight).
If a single message exceeds the context, CodeGoblin surfaces an actionable error instead of
hanging.

## Chat mode (not an agent)

Small local models are **chat assistants, not coding agents**. When a local model is selected,
CodeGoblin automatically:

- strips the agent tool/MCP/skill schemas (~38k tokens — larger than these models' contexts), and
- swaps in a lean neutral chat system prompt (~545 tokens) with no tools and no memory injection.

They answer questions in plain text and decline agentic requests gracefully; pick a cloud model
for tool-using/agentic work.

## codegoblin-native modes

- **one-shot** (default, unchanged): `echo '{"op":"rank",...}' | codegoblin-native` — memory
  ranking / injection-guard scanning over stdin (used by `memory-native.ts`).
- **`llama`**: `codegoblin-native llama --model <gguf> [--engine <llama-server>] [--port 8787]
  [--ngl 99] [--ctx 32768]` — resolves the bundled engine (`--engine` →
  `CODEGOBLIN_LLAMA_SERVER` → sibling `engine/` dir → `CODEGOBLIN_RUNTIME_DIR/engine`) and
  supervises `llama-server`. This is what `codegoblin runtime start` launches.
- **`serve`**: minimal built-in OpenAI-compatible server with a feature-gated inference stub.
  Kept as scaffolding for a possible future static embed (`--features inference` via
  `llama-cpp-2`); the bundled-engine path above is the production route.

## Model catalog

`codegoblin runtime pull <id>` downloads non-gated GGUFs (see `LOCAL_MODEL_CATALOG` in
`packages/codegoblin/src/codegoblin/local-runtime.ts`): `gemma-3n-e2b`, `qwen3-0.6b`,
`qwen3-1.7b`, `qwen2.5-0.5b`. All verified on an RTX 4060 Ti (88–222 tok/s, ≤3.6 GB VRAM at
32k context).

## Build

The default `codegoblin-native` build stays dependency-light (`serde` + `tiny_http`) — no C++
toolchain, no CUDA at build time. The heavy lifting ships as the prebuilt engine downloaded at
`runtime install` time.

```bash
cargo build --release                      # sidecar: one-shot + llama supervisor + serve stub
cargo build --release --features inference # optional future static embed (stub today)
```
