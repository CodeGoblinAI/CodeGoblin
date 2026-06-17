# Getting started

## Install

```bash
npm install -g @codegoblin-io/codegoblin
```

This installs the `codegoblin` CLI (with a short `cg` alias). To build from a source checkout
instead, see [Run from a source checkout](../README.md#run-from-a-source-checkout).

Verify:

```bash
codegoblin --version
```

## First run (the TUI)

Launch the terminal UI from any project directory:

```bash
codegoblin
```

You'll get the goblin splash and a prompt box. A few things to know:

- **Switch models** with the leader key `Ctrl+X` then `m`.
- **Actions menu**: `Ctrl+G`.
- Slash commands start with `/` (e.g. `/help`, `/models`, `/init`).

## Talking to a cloud model

CodeGoblin is bring-your-own-key. Connect a provider (for example, set its API key in your
environment or via the config file) and select one of its models in the picker. See
[Providers & models](providers.md) for the details and the full provider list.

## Talking to a local model (no key, no cloud)

CodeGoblin ships its own on-device runtime — run small models on your own GPU/CPU:

```bash
codegoblin runtime install        # one-time: download the llama.cpp engine for your machine
codegoblin runtime pull qwen3-0.6b
```

Then pick the model in the picker — local models appear in a dedicated **Local models** group,
named `<id> (local)` — and chat. The runtime starts automatically on your first message and
swaps automatically when you pick a different local model. Nothing leaves your machine.

Full details, the model catalog, and troubleshooting are in **[Local models](LOCAL_RUNTIME.md)**.

## One-shot prompts (scripting)

For non-interactive use:

```bash
codegoblin run --model codegoblin/qwen3-0.6b "Explain this regex: ^\\d{3}-\\d{4}$"
```

## The web UI

Prefer a browser? Serve the embedded UI locally:

```bash
codegoblin web --port 4188
# open http://localhost:4188
```

Same sessions, same model picker, same local-first storage as the TUI.

## Where things are stored

Sessions, auth, and settings live under your platform data directory
(`~/.local/share/codegoblin` on Linux/macOS-style layouts). Generated images, audio, and 3D
assets are written into your project under `codegoblin-output/`. See
[Configuration](configuration.md) for overrides.
