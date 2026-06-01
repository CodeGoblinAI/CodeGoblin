# CodeGoblin memory and model settings plan

## Hermes memory research snapshot

CodeGoblin should move toward a Hermes-inspired memory system, but with a stronger local-first default and clearer user controls. The goal is not to copy Hermes line-for-line; it is to copy the parts that make memory reliable: bounded curated facts, full searchable session history, background review, provider plugins, prompt-cache-safe injection, and profile/project isolation.

### What Hermes actually does

- **Curated local memory files:** Hermes keeps `MEMORY.md` and `USER.md` under `~/.hermes/memories/`. `MEMORY.md` is for agent/project/environment notes; `USER.md` is for user identity, preferences, communication style, and workflow expectations.
- **Small bounded facts:** Current Hermes defaults are roughly 2,200 chars for `MEMORY.md` and 1,375 chars for `USER.md`. The small budget is intentional: memory is for high-signal durable facts, not task logs.
- **Frozen prompt snapshots:** memory is read once at session start and injected as a frozen system-prompt block. Mid-session writes persist to disk immediately, but they do not mutate the active prompt until a new session or context-compression rebuild. This preserves provider prefix caching and makes memory behavior understandable.
- **Tool-managed writes:** the `memory` tool supports `add`, `replace`, and `remove`. `replace`/`remove` use short unique substring matching instead of IDs.
- **Security scanning:** memory entries are scanned before write and again before system-prompt injection. Suspicious entries are blocked from prompt injection while remaining visible for user cleanup.
- **Session search is separate from memory:** every session/message is stored in SQLite with FTS5. `session_search` recalls old conversations on demand; curated memory stays tiny and always-on.
- **Background review:** after configured turn intervals, Hermes spawns a quiet review agent that can only use memory/skill tools. It reviews the completed conversation for durable memories and reusable skills without interrupting the main task.
- **External memory provider plugins:** one external provider can run alongside built-in memory. Providers can inject static prompt text, prefetch recall before a turn, sync completed turns, expose provider-specific tools, mirror built-in memory writes, react before compression, handle session switches, and flush on true session end.
- **Honcho mode:** Hermes' Honcho integration adds AI-native user modeling. It uses user/AI peers, workspaces, per-profile AI identities, session summaries, user representation, peer cards, semantic search, persistent conclusions, and a dialectic reasoning layer refreshed by configurable cadences.

### Hermes patterns CodeGoblin should copy

1. **Curated memory + session recall split**
   - Keep always-injected memory compact.
   - Store every session/message separately for search, browsing, and handoffs.
   - Use memory for durable facts; use session search for “what happened last week?”
2. **Frozen prompt boundary**
   - Build a stable system prompt once per session.
   - Inject fetched memory/recalled context into a clearly fenced block.
   - Do not mutate prompt memory mid-stream because it breaks cache behavior and can confuse the model about whether it already saw a fact.
3. **Provider abstraction**
   - Keep a built-in local provider always available.
   - Allow only one external memory provider at a time to avoid tool-schema bloat and conflicting recall.
   - Make provider setup explicit and visible.
4. **Background review instead of blind autosave**
   - Run best-effort review after significant turns/sessions.
   - Restrict the review worker to memory/skill write tools.
   - Summarize what the worker changed so the user can audit it.
5. **Pre-compression extraction**
   - Before context compression discards old turns, notify memory providers and include extracted facts in the compression summary.
6. **Profile/project isolation**
   - Keep a default user profile, per-project memory, and optional named agent profiles separate.
   - Never let a project memory write silently alter global user memory unless the user asked for durable global persistence.
7. **Prompt-injection hygiene**
   - Scan memory/context files before prompt injection.
   - Fence recalled memory as background/reference data, not new user input.
   - Scrub memory-context fences from captured transcripts so the system does not recursively memorize injected context.

### Hermes patterns CodeGoblin should adapt, not copy blindly

- Hermes docs sometimes describe “completed work” as memory-worthy, while current Hermes prompt/tool guidance explicitly says not to save task progress, PR numbers, commit SHAs, or completed-work logs as durable memory. CodeGoblin should follow the stricter rule: task progress belongs in session history and handoffs, not global memory.
- Hermes supports cloud providers like Honcho, Mem0, RetainDB, and Supermemory. CodeGoblin should expose those only as opt-in providers with clear data-location warnings.
- Honcho is powerful but not a local default: self-hosting requires PostgreSQL with pgvector, Redis, an API service, and a deriver/background worker. CodeGoblin should design the local provider first, then add Honcho as an optional advanced backend.

## Proposed CodeGoblin memory architecture

### Scopes

1. **User memory**
   - Durable preferences, repeated corrections, identity, timezone, communication style, and long-lived workflow expectations.
   - Stored outside individual project workspaces in CodeGoblin's user data directory.
   - Never synced unless the user explicitly configures a provider.
2. **Project memory**
   - Repo conventions, exact commands, verified setup facts, architecture notes, and known gotchas.
   - Stored under CodeGoblin's project data path; optionally exportable to repo files such as `AGENTS.md` when the user asks.
3. **Session memory**
   - Active task state, current branch, todos, review notes, pending failures, and temporary handoff details.
   - Searchable and resumable, but not automatically promoted into user/project memory.
4. **Provider memory**
   - Optional external semantic/graph/user-model providers.
   - Additive to local memory, never a silent replacement.

### Storage MVP

- SQLite in CodeGoblin durable app data.
- Tables:
  - `memory_entry`: id, scope, project_id, profile_id, content, tags, pinned, confidence, source_session_id, source_message_id, created_at, updated_at, archived_at.
  - `memory_audit`: entry_id, action, old_content, new_content, actor, reason, timestamp.
  - `session`: id, project_id, title, branch, model, provider, started_at, ended_at, parent_session_id, token/cost fields.
  - `session_message`: id, session_id, role, content, metadata JSON, timestamp, token_count.
  - `session_message_fts`: FTS5 index over message content, tool names, and metadata excerpts.
  - `memory_entry_fts`: FTS5 index over memory content and tags.
- Use WAL where available, with a Windows/network-filesystem fallback if locking gets noisy.
- Use idempotent migrations and keep schema changes additive when possible.

### Runtime flow

1. **Capture candidates**
   - Explicit “remember this” and high-confidence corrections become candidates immediately.
   - Background review can propose candidates after every N turns or on session end.
2. **Review and write**
   - Direct explicit memories can write immediately with audit metadata.
   - Inferred memories should be queued as reviewable candidates unless confidence is high.
3. **Retrieve**
   - At session start, load pinned/global/project memories as a frozen snapshot.
   - Before each turn, run scoped FTS/session recall and optional provider prefetch for relevant context.
4. **Inject**
   - Render memory as a labeled CodeGoblin block.
   - Render dynamic recall as a fenced `<codegoblin-memory-context>` block appended to the current user message, not merged into the cached system prompt.
5. **Sync providers**
   - After a successful turn, asynchronously sync the clean user/assistant turn and relevant metadata to the active provider.
   - Strip prior memory-context fences before syncing to avoid recursive pollution.
6. **Session end/compression**
   - On session end, run a final review and flush provider queues.
   - Before compression, let local/provider memory extract facts from the soon-to-be-summarized span.

### Provider plugin contract

CodeGoblin's memory provider interface should mirror Hermes' lifecycle while using TypeScript/Effect conventions:

- `name()` — stable provider id.
- `isAvailable()` — local config/dependency check only; no network calls.
- `initialize(sessionId, context)` — profile/project/user/session scoped setup.
- `systemPromptBlock()` — static provider status/instructions only.
- `prefetch(query, context)` — fast recall for the upcoming turn.
- `queuePrefetch(query, context)` — prewarm recall for the next turn.
- `syncTurn(user, assistant, context)` — non-blocking turn ingestion.
- `getToolSchemas()` / `handleToolCall()` — provider-specific tools.
- `onMemoryWrite(action, target, content, metadata)` — mirror local writes.
- `onPreCompress(messages)` — save/extract before compaction.
- `onSessionSwitch(newSessionId, metadata)` — update cached session identity.
- `onSessionEnd(messages)` and `shutdown()` — final extraction/flush.

Only one external provider should be active at a time. The local provider remains active beside it.

### Honcho as optional advanced provider

If/when CodeGoblin wires Honcho, map CodeGoblin concepts like this:

- CodeGoblin user profile → Honcho user peer.
- CodeGoblin agent/profile → Honcho AI peer.
- CodeGoblin project/workspace → Honcho workspace.
- CodeGoblin session strategy → per-session, per-directory, per-repo, branch, or global session mapping.
- CodeGoblin recall mode → `hybrid`, `context`, or `tools`.
- CodeGoblin cost controls → Honcho `contextCadence`, `dialecticCadence`, `dialecticDepth`, `contextTokens`, and `writeFrequency`.

Default recommendation: local SQLite provider first; Honcho later as opt-in `cloud` or `selfHosted` backend with a status screen that shows where data is going.

### User controls

- CLI/TUI/Web commands:
  - `cg memory status`
  - `cg memory list --scope user|project|session`
  - `cg memory add|replace|remove`
  - `cg memory review`
  - `cg memory export`
  - `cg memory provider setup|status|off`
- UI affordances:
  - show when memory was injected
  - show source session/message for each memory
  - allow pin/unpin, archive, delete, and edit
  - show provider data-location labels: `local`, `self-hosted`, or `cloud`

### Safety/privacy constraints

- Never hide cloud sync behind defaults.
- Store secrets as references only; do not write API keys/tokens into memory.
- Keep source attribution for each memory.
- Prefer short atomic memories over long summaries.
- Do not save task progress, transient errors, or completed-work diary entries to durable user memory.
- Require explicit confirmation before promoting session memory to user/global memory.

## Model and audio settings direction

### Current shipped direction

- Audio generation is routed separately from chat.
- ElevenLabs generation supports voice ID, output format, stability, similarity, style, speed, speaker boost, language code, seed, and text normalization.
- Web audio confirmation lists ElevenLabs speakers through `/codegoblin/audio/voices` when a key is available, while still allowing manual voice IDs.
- CLI and web allow blank voice selection so CodeGoblin can auto-pick a generated account voice.

### Next settings improvements

1. **Provider setting schema**
   - Add a provider/model settings registry for fields like speaker, temperature, quality, size, style, and seed.
   - Keep per-provider validation close to the route/command that sends the request.
2. **Saved presets**
   - Save named audio/image presets per project and per user.
   - Let users mark a default speaker/model preset.
3. **CLI parity**
   - Add interactive voice selection to the CLI audio flow in addition to the current `--list-voices` support.
   - Keep non-interactive flags for automation.
4. **TUI parity**
   - Surface selected speaker/settings in progress metadata and sidebar/status lines.
   - Keep activity animation state-driven only: pending reply, image progress, audio progress, spend/token delta.
5. **Provider-specific UI**
   - Show only supported settings for the selected model.
   - Degrade gracefully when a provider cannot list speakers/settings.

## Companion UX requirements carried forward

- Home header uses variant 09 by default.
- Sidebar companion uses sprite 40/menuHeadWide as the corrected resting goblin.
- Runtime spend/token-burn animation uses action variant 03.
- Action animation triggers only from real session cost/token deltas.
- Thinking/image/audio animations trigger only from real runtime states.
- `CODEGOBLIN_COMPANION_PREVIEW` remains dev-only for review/demo loops.

## Pass 2 implementation status (branch `feat/codegoblin-pass-2`)

Delivered this pass (all behind compat-safe surfaces; `opencode.json`/`.opencode`/`@opencode-ai/*`/`OPENCODE_*` unchanged):

1. **Memory wiring (Hermes-inspired).**
   - `src/codegoblin/memory.ts` — write API (`add`/`get`/`search`/`remove`/`restore`/`setPinned`), 1,000-char cap, scope normalization, project-id validation.
   - `src/codegoblin/memory-guard.ts` — `scanMemoryContent()` threat patterns (instruction override, role reassignment, forged `<system>`/`<memory-context>` tags, credential exfil). Scanned before write.
   - `src/codegoblin/memory-context.ts` — `buildMemoryContext()` renders a fenced `<memory-context>` block (user/project/session, pinned first) marked authoritative-background, not user instruction.
   - `src/tool/memory.ts` — agent `memory` tool (`add`/`list`/`search`/`remove`). Injected into the system prompt via `src/session/system.ts` + `src/session/prompt.ts` (recall keyed on the last user message). CLI write commands in `src/cli/cmd/memory.ts`.
2. **`/image` + `/audio` settings.** `src/cli/cmd/tui/codegoblin/media-settings.ts` + `dialog-media-settings.tsx`; KV-persisted output dir / voice / format / auto-approve. Web app has no media-generation UI yet, so there is nothing to persist there (deferred until a web media dialog exists).
3. **CodeGoblin Market.** `src/codegoblin/market.ts` — curated catalog (Supabase, Playwright, Firebase, Notion, GitHub, Context7, Sentry, filesystem). `cg market list|show|add` (`src/cli/cmd/market.ts`, writes MCP entries to `opencode.json` via jsonc-parser, identical to `cg mcp add`) and a read-only `/market` TUI browser (`dialog-market.tsx`).

### Reference-repo attributions (the "bits and pieces" mined)

- **Hermes** — curated/bounded memory facts, frozen `<memory-context>` system-prompt block, tool-managed writes, scan-before-inject. Implemented above.
- **ECC** — prompt-injection threat-pattern catalog reused in `memory-guard.ts` (forged-tag and instruction-override detection).
- **agentmemory** — substring/term search fallback over SQLite (`memory.search` splits the query into `like` OR-terms) so recall works without an embedding store.
- **codegraph** — efficiency idea: bounded, ranked recall (pinned-first, per-scope caps of 12/12/6) keeps the injected block small and cache-stable rather than dumping all memory.
- **jcode** — efficiency idea: static, reviewed catalog data (no network at catalog-read time) for the market, mirroring jcode's precomputed-manifest approach.
