# CodeGoblin Work Continuation — 2026-05-28

Last updated: 2026-05-28.

This note is a **fresh continuation handoff** for the latest CodeGoblin session.
Read this alongside:

1. `C:\Users\shawn\.codex\skills\codegoblin-project-brain\SKILL.md`
2. `docs/CODEGOBLIN_WORK_COMPUTER_HANDOFF.md`

This file is the fastest way to resume from work without re-discovering what changed.

## Current repo state

- Repo: `C:\Users\shawn\OneDrive\Documents\coding stuff\CodeGoblin`
- Branch: `dev`
- Latest commit: `464ad8468 feat(audio): add ElevenLabs generation flow`
- Working tree status at handoff creation: clean
- Local installed build verified at end of session:
  - `codegoblin --version` → `0.0.0-dev-202605280353`
  - `cg --version` should match the same build after relink

## What was completed today

### ElevenLabs / audio support

The main goal was making ElevenLabs/audio actually usable across CLI, web, and TUI.

Completed:

- ElevenLabs audio models now appear in web and TUI model pickers.
- Audio-only models are selectable intentionally, but they are **not** allowed to become the default chat fallback model.
- Added dedicated web audio generation flow instead of letting audio models fall through normal chat behavior.
- Added dedicated TUI audio generation flow instead of letting selected audio models route to standard chat.
- Added local server audio routes:
  - `POST /codegoblin/audio`
  - `GET /codegoblin/output-audio`
- Added audio result rendering in chat UI, including local playback.
- Added richer CLI audio options for ElevenLabs:
  - output format
  - stability
  - similarity boost
  - style
  - speed
  - speaker boost
  - language code
  - seed
  - text normalization options
- Added parent `.env` discovery so audio/image helpers can load keys from outside the repo tree.
- Added support for both:
  - `ELEVENLABS_API_KEY`
  - `CODEGOBLIN_ELEVENLABS_API_KEY`
- Added connected-provider auth fallback for ElevenLabs.
- Added automatic generated-voice selection when no explicit ElevenLabs voice is configured.
  - This matters because the old default library voice failed on this account with paid-plan restrictions.

### Web UX cleanup

- Cleaned up the web “Generate image?” dialog so it looks more productized.
- Added styled web “Generate audio?” dialog with controls for:
  - voice ID
  - output format
  - stability
  - similarity
  - style
  - speed
  - speaker boost
  - language code
  - text normalization
- The audio dialog now explicitly tells the user they can leave Voice ID blank to auto-pick a generated ElevenLabs voice from the account.

### Model bucket / selection behavior

Updated both web and TUI model bucketing/selection logic:

- Real image-output models stay in image buckets.
- Vision-capable text models do **not** get mislabeled as image generators.
- Audio-only models are now visible/selectable as dedicated audio models.
- Audio-only models are excluded from default chat fallback selection.

### Chat/result rendering

Added audio result cards in shared UI so audio generations show up in chat with:

- provider/model
- saved output path
- copy output path button
- open output folder button
- local `<audio controls>` playback via `/codegoblin/output-audio`

## Files changed in this pass

Primary files touched:

- `packages/opencode/src/codegoblin/audio-command.ts`
- `packages/opencode/src/cli/cmd/audio.ts`
- `packages/opencode/src/codegoblin/image-command.ts`
- `packages/opencode/src/server/routes/instance/httpapi/server.ts`
- `packages/opencode/src/codegoblin/model-bucket.ts`
- `packages/opencode/src/cli/cmd/tui/context/local.tsx`
- `packages/opencode/src/cli/cmd/tui/component/prompt/index.tsx`
- `packages/app/src/utils/model-buckets.ts`
- `packages/app/src/context/local.tsx`
- `packages/app/src/components/prompt-input/submit.ts`
- `packages/app/src/components/prompt-input.tsx`
- `packages/ui/src/components/message-part.tsx`
- `packages/ui/src/components/message-part.css`
- focused tests in `packages/app` and `packages/opencode`

## Validation that passed

### Focused tests

Ran successfully:

```text
packages/opencode:
- bun test test/codegoblin/audio-command.test.ts test/codegoblin/model-bucket.test.ts test/codegoblin/image-command.test.ts

packages/app:
- bun test src/components/prompt-input/submit.test.ts src/utils/model-buckets.test.ts
```

Results at end of session:

- `packages/opencode`: 17 passing
- `packages/app`: 13 passing

### Typechecks

Passed:

```text
bun typecheck  (from packages/opencode)
bun typecheck  (from packages/app)
bun typecheck  (from packages/ui)
```

### Live verification performed

#### Parent env check

Verified the parent env exists and contains a non-empty ElevenLabs key **without printing the secret**.

User-confirmed secure env location:

- `C:\Users\shawn\OneDrive\Documents\coding stuff\.env`

Observed variable present:

- `ELEVENLABS_API_KEY`

#### CLI live audio smoke

A real CLI test succeeded using the parent `.env` and auto-selected generated voice.

Successful output example:

- `codegoblin-output/audio/elevenlabs-auto-smoke-202605280341.mp3`
- file size observed: `8691` bytes
- successful generated voice: `VqivOVSGLc7vk3SqMFch`

Important discovery:

- The previous default library voice failed with ElevenLabs paid-plan restrictions.
- The fix was to auto-pick a generated voice from the user’s account when no explicit voice is provided.

#### Web route smoke

A live server test against the web audio route succeeded:

- `POST /codegoblin/audio` returned `ok: true`
- `GET /codegoblin/output-audio` returned:
  - status `200`
  - content type `audio/mpeg`
  - nonzero bytes

#### Browser/UI smoke

Browser verification confirmed:

- searching `eleven` in the model picker now shows ElevenLabs models
- selecting `ElevenLabs Text to Speech` works
- the web audio settings dialog appears
- generating audio from the UI works
- resulting chat shows an audio result card with saved path and metadata

## Important behavior to remember

### Audio flow rules

- Audio models should **not** be treated as normal text chat defaults.
- If an audio model is intentionally selected, web/TUI should route to CodeGoblin audio generation, not to ordinary session chat.
- Blank voice ID should auto-select a generated ElevenLabs voice from the account.
- If a user wants a specific voice, they can still set one explicitly.

### Parent `.env` behavior

The repo now supports loading keys from parent directories via controlled upward `.env` lookup.
That was needed because the user moved the secure env out of the repo to:

- `C:\Users\shawn\OneDrive\Documents\coding stuff\.env`

This was intentionally allowed so the key does not need to live inside the repo tree.

## Known loose ends / next good tasks

These are the best follow-up tasks if work continues from here:

1. **Add dedicated TUI audio settings UI**
   - TUI now routes audio correctly, but it still uses a lighter confirmation flow than the web dialog.
   - Web currently has the richer audio settings experience.

2. **Broaden automated coverage for server audio routes**
   - The live route checks passed, but direct automated tests for `/codegoblin/audio` and `/codegoblin/output-audio` could still be added.

3. **Decide whether to expose preferred default ElevenLabs voice config in Settings/UI**
   - Right now auto-generated voice fallback works well.
   - A future product pass could add a first-class preferred voice setting.

4. **If more work is needed on deployment/cloud paths, treat it separately**
   - Today’s work focused on local CLI/web/TUI audio usability, not hosted deploy infra.

## Recommended resume steps on the work machine

Use this order:

1. Open the repo on `dev`
2. Read:
   - `C:\Users\shawn\.codex\skills\codegoblin-project-brain\SKILL.md`
   - `docs/CODEGOBLIN_WORK_COMPUTER_HANDOFF.md`
   - `docs/WORK_COMPUTER_CONTINUATION_2026-05-28.md`
3. Confirm latest commit includes:
   - `464ad8468 feat(audio): add ElevenLabs generation flow`
4. Rebuild/relink if needed:

```powershell
cd "C:\Users\shawn\OneDrive\Documents\coding stuff\CodeGoblin"
$env:PATH='C:\Users\shawn\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin;' + $env:PATH
npm run build
npm run link:local
codegoblin --version
```

5. If doing a quick smoke:

```powershell
cg audio "CodeGoblin work-machine smoke test." --key-file "C:\Users\shawn\OneDrive\Documents\coding stuff\.env"
```

6. If continuing product work, start with TUI audio settings parity or route-level automated tests.

## Short human summary

Today’s session fixed the broken ElevenLabs experience end to end:

- audio models now show up
- audio no longer falls into normal chat
- parent `.env` keys work
- CLI works live
- web works live
- TUI routes correctly
- chat can render audio results

If resuming from work, the safest mental model is:

> the local audio pipeline is now functional; the next phase is polishing settings UX and adding a bit more automation around the server/TUI path.
