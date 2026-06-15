# CodeGoblin documentation

CodeGoblin is a local-first AI coding agent with a terminal UI, a web UI, and bring-your-own-key
provider support. Prompts, sessions, and generated assets stay on your machine by default.

## Guides

- **[Getting started](getting-started.md)** — install, first run, your first chat (cloud and local).
- **[Local models](LOCAL_RUNTIME.md)** — run small models on your own GPU/CPU with the bundled
  llama.cpp runtime. No Ollama or LM Studio required.
- **[Configuration](configuration.md)** — config file, environment variables, and where data lives.
- **[Providers & models](providers.md)** — connecting cloud providers, BYOK, and picking models.
- **[Image, audio & 3D](media.md)** — generating images, speech/music, and 3D models.
- **[Themes](themes.md)** — switching and customizing the look.

## Quick reference

```bash
codegoblin                 # launch the terminal UI (alias: cg)
codegoblin web             # serve the web UI on http://127.0.0.1:<port>
codegoblin run "..."       # one-shot prompt, non-interactive
codegoblin models          # list available models
codegoblin runtime install # set up the local model runtime (one time)
codegoblin <command> --help
```

CodeGoblin is an independent fork/customization of the MIT-licensed
[OpenCode](https://github.com/anomalyco/opencode). For inherited behavior not yet documented here,
the upstream concepts often still apply, but prefer these docs and `--help` for CodeGoblin specifics.
