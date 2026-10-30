# Local models

There are two routes. Most of the time you want the first.

## CG-Next's own runtime (Local models in the picker)

Every GGUF CG-Next can find appears under **Local models** in the TUI and web pickers as `llama/<file name>`. Pick one and send a prompt: CG-Next starts `llama-server` for it (a few seconds on the GPU), swaps it when another local model is picked, and stops it when CG-Next exits. Nothing to launch by hand.

- **Models** are read from CG-Next's own folder (`<data>/local/models`) plus, read-only, `~/.local/share/cg-next/models` (earlier test downloads) and the fork's `~/.local/share/codegoblin/runtime/models`. `CODEGOBLIN_LOCAL_MODEL_DIRS` (path-separated) replaces the shared folders; empty means none. Projector (`mmproj`) files and later parts of split models are not offered.
- **Engine**: `CODEGOBLIN_LOCAL_ENGINE` if set (and only that), else `<data>/local/engine/llama-server.exe`, else the fork's engine, run read-only. A CUDA build (`ggml-cuda.dll` beside it) offloads all layers to the GPU; `CODEGOBLIN_LOCAL_GPU=0` forces CPU.
- **Ownership**: one server per CG-Next process, as its child, on a free loopback port. Each start gets a random API key (passed in `LLAMA_API_KEY`, not on the command line); a server counts as CG-Next's only if it answers to that key. The fork's `runtime.json` and port 8787 are never read as ours, stopped or swapped. If a CG-Next process is killed outright, the next one stops the server it left behind, but only if that server still answers to the recorded key.
- **Concurrency**: a running answer leases the server, compaction and subagents included. Another conversation asking for a different local model meanwhile gets a clear refusal rather than a swap mid-answer.
- **Tools**: models of 4 GB and up (and Bonsai) are offered CG's tools. Smaller ones get the lean chat prompt, since they mostly misuse tools. `/local tools on|off|auto` overrides it per model.
- **Context**: 16,384 tokens by default (32,768 for Bonsai, with its Q4 KV cache). Use `/local context <tokens>|auto` to change it; a running, idle server restarts with the new size.

`/local` shows the engine, the server (model, port, pid, context, uptime, log path), any download, the installed models and where they were looked for. `/local stop` frees the memory and refuses while an answer is running.

### Downloading models

`/local pull` opens a list of official Qwen3 GGUFs (0.6B, 1.7B, 4B, 8B). Picking one shows its size, source (`huggingface.co/Qwen/...`) and destination, and nothing is fetched until you confirm. Each file is pinned to the size and SHA-256 the Hugging Face API reported on 2026-10-30. The download goes to `<file>.part` and is renamed only when both match; a mismatch is discarded. Redirects are followed only to Hugging Face hosts over HTTPS. Free disk space is checked first. One download runs at a time; `/local cancel` stops it and keeps the `.part`, and the next `/local pull` resumes it with a Range request. The web dialog can be closed while it runs; `/local` shows progress in both surfaces.

Engine downloads are not built yet. The fork's CUDA engine is used read-only, or drop `llama-server.exe` and its DLLs into `<data>/local/engine`.

### Measured tool use (2026-10-30)

Five small tasks through the real agent loop in a throwaway workspace: read a line, write a file, rename a function in a file, count `.md` files, and read JSON then write one field to a file. Tools forced on, every call approved, 8-turn cap, on the RTX 4060 Ti with about 6 GB of VRAM free.

| Model | Passed | Per task | Behaviour |
|---|---|---|---|
| Qwen3 1.7B Q8_0 | 4/5 | 3-203 s | Rename looped into the 8-turn cap (11 calls). The read-then-write took 9 calls and 17k output tokens. |
| Bonsai 2 27B | 5/5 | 39-119 s (10 s load) | Minimal calls: one `read_file`, or `read_file` then `write_file`. Slow prefill, consistent with the model plus 32k context not fitting in free VRAM. |

That is why tools are on by default only from 4 GB. Qwen3 4B and 8B (in `/local pull`) are the untested middle ground.

## An external server you run yourself (CODEGOBLIN_LOCAL_URL)

CG-Next can also use an already-running, unauthenticated OpenAI-compatible server on localhost. It appears as **Local server** in the picker. CG-Next never starts, stops or swaps that server, and it does not change the fork's runtime state.

## Test the TUI normally (PowerShell)

```powershell
Set-Location 'C:\Users\shawn\code\CG-Next'
bun run tui -- --model zai/glm-5.3-flash
```

Use any connected text model from `/model` if that ID is not available to your account. While it is working, press Shift-Tab or enter `/approvals`. Theme/thinking/help/effort controls also work; ordinary prompts and commands that replace the session or change models queue. Escape closes a picker, then clears typed input, then stops the active turn.

## Bonsai on this machine

The fork has `llama-server.exe` and `bonsai-2-27b.gguf` at the paths below. Loading a 27B model consumes substantial RAM/VRAM. This setup has not been verified against actual inference in this pass. Port 8788 is intentionally separate from the fork's saved port 8787.

First PowerShell terminal (keep open; Ctrl-C stops the server):

```powershell
& 'C:\Users\shawn\.local\share\codegoblin\runtime\engine\llama-server.exe' --model 'C:\Users\shawn\.local\share\codegoblin\runtime\models\bonsai-2-27b.gguf' --alias bonsai-2-27b --host 127.0.0.1 --port 8788 --ctx-size 8192 --n-gpu-layers 99 --jinja --cache-type-k q4_0 --cache-type-v q4_0 --temp 1.0 --top-p 0.95 --top-k 20
```

Second PowerShell terminal, once the server is ready:

```powershell
Set-Location 'C:\Users\shawn\code\CG-Next'
$env:CODEGOBLIN_LOCAL_URL = 'http://127.0.0.1:8788/v1'
$env:CODEGOBLIN_LOCAL_MODEL = 'bonsai-2-27b'
$env:CODEGOBLIN_LOCAL_CONTEXT = '8192'
$env:CODEGOBLIN_LOCAL_TOOLS = '1'
bun run tui -- --model local
```

The same environment works with `bun run web`; select Local in its model picker. The model ID must match your server. For another already-running server, change the URL and model ID. URLs must use HTTP loopback and must not contain credentials, queries or fragments. Local requests never send a stored API key.

Set `CODEGOBLIN_LOCAL_TOOLS` to `0` (the default) for smaller/chat-only models: a lean system prompt and no tools are sent. Tool mode uses the normal coding-agent prompt and the same consent/rule checks as hosted models. Effort preferences do not automatically imply local-model support.

The server must expose `/v1/models` and report the configured model ID (or alias). CG-Next checks this before inference: llama.cpp can otherwise silently answer with a different loaded model. Use a dedicated port if another application manages your local server.

For llama.cpp/Qwen templates, `CODEGOBLIN_LOCAL_THINKING=0` sends `chat_template_kwargs.enable_thinking=false`; `1` enables it, and leaving it unset preserves the server default. This is different from `/thinking`, which only changes whether reasoning is shown. It avoids raw `</think>` markers observed with Qwen's zero-budget server configuration.

## Qwen3 CPU test setup (2026-09-20)

Qwen3 0.6B Q8_0 was downloaded from the official Qwen repository and verified against its SHA-256: `9465e63a22add5354d9bb4b99e90117043c7124007664907259bd16d043bb031`.

```powershell
& 'C:\Users\shawn\.local\share\codegoblin\runtime\engine\llama-server.exe' --model 'C:\Users\shawn\.local\share\cg-next\models\Qwen3-0.6B-Q8_0.gguf' --alias qwen3-0.6b --host 127.0.0.1 --port 18991 --ctx-size 4096 --n-gpu-layers 0 --threads 4 --parallel 1 --jinja --predict 1024
```

In a second PowerShell terminal:

```powershell
Set-Location 'C:\Users\shawn\code\CG-Next'
$env:CODEGOBLIN_LOCAL_URL = 'http://127.0.0.1:18991/v1'
$env:CODEGOBLIN_LOCAL_MODEL = 'qwen3-0.6b'
$env:CODEGOBLIN_LOCAL_CONTEXT = '4096'
$env:CODEGOBLIN_LOCAL_TOOLS = '0'
$env:CODEGOBLIN_LOCAL_THINKING = '0'
bun run tui -- --model local
# Or: bun run web
```

This model passed basic chat/arithmetic and streamed in both interfaces. It is an inexpensive UI smoke-test model, not a validated coding agent: long-form and programming answers were shallow. The 1024-token server budget is deliberate for testing; CG-Next now warns when an answer reaches that limit.

Qwen3 1.7B Q8_0 is also downloaded as `C:\Users\shawn\.local\share\cg-next\models\Qwen3-1.7B-Q8_0.gguf` (SHA-256 `061b54daade076b5d3362dac252678d17da8c68f07560be70818cace6590cb1a`). To try it, stop the other test server first, replace the model path and alias above with `Qwen3-1.7B-Q8_0.gguf` / `qwen3-1.7b`, and set `CODEGOBLIN_LOCAL_MODEL=qwen3-1.7b`. The user pass used `--ctx-size 2048`, `CODEGOBLIN_LOCAL_CONTEXT=2048`, and `--predict 256` to keep memory and test duration bounded. Both frontends produced responses; coding-tool reliability is not yet validated.

Official model sources: [Qwen3 0.6B GGUF](https://huggingface.co/Qwen/Qwen3-0.6B-GGUF), [Qwen3 1.7B GGUF](https://huggingface.co/Qwen/Qwen3-1.7B-GGUF).

## Verification

```powershell
Set-Location 'C:\Users\shawn\code\CG-Next'
bun typecheck
bun run test
node script/test-live-controls.mjs
```

The PTY test uses a deterministic local streaming fixture, not a paid provider or actual model. It borrows the fork's installed Node PTY module; `CODEGOBLIN_TEST_PTY` can override its path. Test profiles are retained in the temporary directory and their paths are printed.
