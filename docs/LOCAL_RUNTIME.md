# CodeGoblin local runtime (first-party inference)

CodeGoblin ships its **own** on-device inference runtime rather than depending on Ollama or
LM Studio. It lives inside the existing `codegoblin-native` Rust sidecar and speaks the
OpenAI-compatible HTTP API the `codegoblin` provider already targets (`http://127.0.0.1:8787/v1`).

## Architecture

```
codegoblin (TUI/web)
   │  OpenAI-compatible HTTP
   ▼
codegoblin-native serve   ──►  inference::generate()
  /v1/models                     ├─ default build: stub message
  /v1/chat/completions           └─ --features inference: llama.cpp (Slice 2)
  /health
```

`codegoblin-native` has two modes:

- **one-shot** (default, unchanged): `echo '{"op":"rank",...}' | codegoblin-native` — memory
  ranking / injection scanning over stdin. This is how `memory-native.ts` already uses it.
- **serve**: `codegoblin-native serve` — the local runtime HTTP server.

```bash
# defaults: 127.0.0.1:8787, label "codegoblin-local"
codegoblin-native serve
CODEGOBLIN_NATIVE_ADDR=127.0.0.1:8787 CODEGOBLIN_NATIVE_MODEL_LABEL=my-model codegoblin-native serve
```

## Slices

- **Slice 1 (this PR):** serving plumbing — OpenAI-compatible `/v1/models`,
  `/v1/chat/completions` (streaming + non-streaming), `/health`. Generation is feature-gated;
  the default build returns a clear "no inference backend" message so the whole path is testable
  without compiling llama.cpp.
- **Slice 2:** real generation behind `--features inference`. Wire `llama-cpp-2`, load a GGUF
  model from `CODEGOBLIN_NATIVE_MODEL`, build the prompt from the chat messages, and stream
  decoded tokens. Built/tuned on an NVIDIA box (CUDA), CPU fallback otherwise. The integration
  point is `inference::generate()` — the HTTP layer does not change.
- **Slice 3:** CLI launcher (`codegoblin` spawns `codegoblin-native serve`), provider activation,
  model management (download/list GGUF), and real token streaming.

## Build

The default build is dependency-light (`serde` + `tiny_http`) and compiles on any platform with
no native toolchain beyond Rust. The `inference` feature is what pulls in llama.cpp and its CUDA
build requirements, so CI and normal installs stay fast.

```bash
cargo build --release                     # serving plumbing, stub generation
cargo build --release --features inference # Slice 2: real llama.cpp backend
```
