# CodeGoblin memory and model settings plan

## Hermes-inspired memory direction

CodeGoblin should move toward a local, user-visible memory system similar in spirit to Hermes without copying its internals wholesale.

### Goals

- Keep useful memory consistent across chats, sessions, and projects.
- Make memory inspectable, editable, and deletable by the user.
- Keep project-specific facts separate from global/user facts.
- Use local storage first; do not silently sync private memory to a cloud service.
- Retrieve memory by semantic/session relevance and inject it through a clearly marked prompt context block.

### Proposed scopes

1. **User memory**
   - Durable preferences, repeated instructions, identity preferences, and long-lived workflow patterns.
   - Stored outside individual project workspaces.
2. **Project memory**
   - Repo conventions, commands, architecture notes, verified setup facts, and known gotchas.
   - Stored under the project data path and optionally mirrored to a user-approved repo file.
3. **Session memory**
   - Temporary task state, active todos, handoff notes, current branch/review context.
   - Expires or compacts into project/user memory only after explicit review.

### Storage MVP

- SQLite database in the existing durable app data location.
- Tables for memories, sessions, message references, tags/scopes, and audit history.
- FTS5 index for keyword recall.
- Optional embedding index later, gated behind explicit provider configuration.

### Runtime flow

1. Save candidate memories from explicit user requests and high-confidence repeated facts.
2. Run a memory review pass after significant sessions or handoff creation.
3. Retrieve scoped memories for new prompts using project/session/user filters.
4. Render retrieved memories as a labeled CodeGoblin memory block.
5. Offer commands/UI for review, edit, pin, forget, and export.

### Safety/privacy constraints

- Never hide cloud sync behind defaults.
- Store secrets as references only; do not write API keys/tokens into memory.
- Keep source attribution for each memory so the user can audit where it came from.
- Prefer short atomic memories over long summaries.

## Model and audio settings direction

### Current shipped direction

- Audio generation is routed separately from chat.
- ElevenLabs generation supports voice ID, output format, stability, similarity, style, speed, speaker boost, language code, seed, and text normalization.
- Web audio confirmation now lists ElevenLabs speakers through `/codegoblin/audio/voices` when a key is available, while still allowing manual voice IDs.
- CLI and web continue to allow blank voice selection so CodeGoblin can auto-pick a generated account voice.

### Next settings improvements

1. **Provider setting schema**
   - Add a provider/model settings registry for fields like speaker, temperature, quality, size, style, and seed.
   - Keep per-provider validation close to the route/command that sends the request.
2. **Saved presets**
   - Save named audio/image presets per project and per user.
   - Let users mark a default speaker/model preset.
3. **CLI parity**
   - Add voice listing/selection to the CLI audio flow.
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
