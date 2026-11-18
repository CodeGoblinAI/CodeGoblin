# CodeGoblin

**Your local AI goblin for code, images and agents.**

CodeGoblin is an AI coding agent that runs on your computer, in your terminal and in your browser. You bring the model: an API key, a subscription you already pay for, or a model running on your own machine. It reads and edits the files in your project, runs commands, searches, and asks before doing anything you have not allowed.

```
npm install -g @codegoblin-io/codegoblin
codegoblin
```

Windows, Linux and macOS (Apple chips), x64 and arm64. The install needs Node 18 or later to start the program; nothing else.

> **Status: early.** 0.4 is a new codebase, written from scratch (versions up to 0.3 were built on a fork of OpenCode). It is used daily by its author and has a large test suite, but expect rough edges. See [Coming from 0.3](#coming-from-03).

## Start

| Command | What it does |
| --- | --- |
| `codegoblin` (or `cg`) | the terminal app, in the current folder |
| `codegoblin <folder>` | the terminal app, in another folder |
| `codegoblin web` | the web app, at http://localhost:4400 |
| `codegoblin run "<prompt>"` | one prompt, the answer printed, then exit |
| `codegoblin upgrade` | update to the newest version (`upgrade 0.3.12` goes to exactly that one) |
| `codegoblin --help` | the rest |

The terminal app and the web app share everything: conversations, keys, settings. Start in one and carry on in the other.

On first start, type `/connect`, pick a provider and paste its key. `/model` switches model, `/` lists every command, and `/help` explains them.

## What it can do

- **Work on code.** Read, search, edit and patch files; run shell commands and watch their output as it comes; leave a dev server or a watcher running in the background (`/jobs`). `/undo` puts back what a turn changed, `/diff` shows what the session changed, `/review` reviews diffs against `REVIEW.md`, and `/verify` runs end-to-end checks.
- **Ask first.** Three modes, switched with shift+tab or `/approvals`: ask before acting, approve edits for me, or full access. Secret files always ask first in every mode, and approvals for commands outside the project stay scoped to that folder. A turn that runs long or spends past a limit pauses and asks to continue.
- **Use the model you have.** API keys for the providers in the [models.dev](https://models.dev) catalogue; official sign-in for ChatGPT (Codex), Claude and Cursor subscriptions (`/login`); and local GGUF models through llama.cpp (`/local`, see [docs/local-models.md](docs/local-models.md)).
- **More than text.** Image, audio and 3D generation with the providers you connect, saved into your project. Voice input (`/voice`). A Chrome it can drive (`/browser`).
- **Extend it.** MCP servers (`/mcp`), skills and custom commands (`/skills`), named agent profiles (`/agents`), project instructions in `AGENTS.md`, and subagents when you ask for them (`/boost`).
- **Keep and move conversations.** `/resume`, `/fork`, `/export`, `/search`, and `/import` to copy a conversation from Codex, Claude Code, Antigravity, Cursor or CodeGoblin 0.3.

## What leaves your computer

Your prompts, conversations, keys and files stay on your machine. CodeGoblin has no account, no server of its own and no telemetry. It makes these connections:

- **The model provider you chose**, with your prompt and the context the model needs. This is the only place your work is sent, and a local model sends it nowhere.
- **Tools you allow**: web search and web fetch when the model uses them, MCP servers you configured, a package manager a command runs.
- **models.dev**, for the list of providers and models. The list is also built into the program, so it works offline.
- **The npm registry**, at most once a day, to see whether a newer version is out. It sends nothing about you. Turn it off with `CODEGOBLIN_DISABLE_AUTOUPDATE=1` or `"autoupdate": false` in `codegoblin.jsonc`. CodeGoblin never updates itself: it tells you, and `codegoblin upgrade` is yours to run.

Keys are kept in `auth.json` in your data folder (`~/.local/share/codegoblin`), readable only by you where the system allows it, and are masked in logs and tool output.

## Coming from 0.3

0.4 uses the same folders as 0.3, so your keys and `codegoblin.jsonc` are already there. Conversations from 0.3 stay in its database; `/import codegoblin` lists the ones for the current project and copies one in as text. 0.4 never writes to that database, so going back is safe:

```
codegoblin upgrade 0.3.12
```

Not in 0.4 yet: the desktop app, the VS Code extension, the GitHub action and the Nix package.

## From source

Needs [Bun](https://bun.sh) 1.4 or later.

```
bun install
bun start                # the terminal app
bun start web            # the web app
bun run test             # the suite
bun run typecheck
bun script/build.ts      # one program for this computer, in dist/
```

`test/user-pass/` holds walkthroughs that drive the terminal app and the web app the way a person does; its README says how to run them.

## License

MIT. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
