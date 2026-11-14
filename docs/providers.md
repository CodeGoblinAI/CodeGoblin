# Providers & models

CodeGoblin is **bring-your-own-key (BYOK)**: you supply credentials for the providers you want,
and they stay local. It also runs **local models** with no key at all (see
[Local models](LOCAL_RUNTIME.md)).

## Listing what's available

```bash
codegoblin providers     # providers CodeGoblin knows about
codegoblin models        # models you can select
```

The models catalog is fetched and cached locally; if the primary source is unreachable it falls
back automatically, so a fresh install still sees the full provider list.

## Connecting a cloud provider

Provide a provider's API key by either:

- setting its key in your environment, or
- adding it to your CodeGoblin config / auth, or
- using the in-app connect flow (`/connect` in the TUI) where supported.

Once a provider is configured, its models appear in the model picker (`Ctrl+X` then `m` in the
TUI, or the dropdown in the web UI). Selecting a model routes your chat to that provider with
your key — CodeGoblin does not proxy your prompts through any hosted service.

## Refuseless

Choose **Refuseless** in `/connect` (TUI) or Settings → Providers (web UI), then enter
your Refuseless API key. You can also set `REFUSELESS_API_KEY` in your environment.
Experiential Labs remains a separate provider with its own key.

Refuseless uses `https://api.refuseless.com/v1` and includes GLM 5.3 / Flash Abliterated,
DeepSeek V4.1 Flash variants, MiniMax M3.1 Flash, and Kimi K3.1 Pro. For example:

```powershell
cg run --model refuseless/glm-5.3-flash-abliterated "Explain this project"
```

Image support and estimated token costs follow the public API catalog. A model id
containing `free` does not override the API's reported price; check your account's
current rates. Refuseless reasoning levels are Low, High, and Max, with Off also
available on DeepSeek routes that support it.

Maintainers can refresh only this provider with
`bun run packages/codegoblin/script/sync-models-catalog.ts --refuseless-only`.
If a full catalog sync cannot reach Refuseless, it retains the previous snapshot.

## Picking a model

- **In the UI**: open the model picker and choose. Models are grouped — including a dedicated
  **Local models** group for on-device GGUFs.
- **From the CLI**: pass `--model <provider>/<id>`, e.g.
  `codegoblin run --model codegoblin/qwen3-0.6b "..."`.

## Local vs cloud at a glance

|              | Cloud models                          | Local models                 |
| ------------ | ------------------------------------- | ---------------------------- |
| Key required | yes (BYOK)                            | no                           |
| Runs on      | the provider's servers                | your machine                 |
| Cost         | your provider billing                 | free (your hardware)         |
| Best for     | agentic/tool-using work, long context | quick chat, privacy, offline |

Local models run as a lean **chat assistant** (tools stripped) because small models aren't built
to be coding agents — pick a cloud model for tool-using/agentic tasks.

## MCP servers and the market

CodeGoblin supports [Model Context Protocol](https://modelcontextprotocol.io) servers:

```bash
codegoblin mcp --help      # add / manage MCP servers
codegoblin market --help   # browse the curated MCP catalog and add entries
```

Added MCP servers are written to your config and become available as tools to agentic
(cloud) models.
