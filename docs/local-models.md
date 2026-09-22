# Local models (first integration)

CG-Next can use an already-running, unauthenticated OpenAI-compatible server on localhost. It does not yet install engines/models or automatically start, stop, or swap servers. It does not change the fork's runtime state.

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
