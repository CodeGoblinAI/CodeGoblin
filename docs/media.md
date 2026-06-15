# Image, audio & 3D

CodeGoblin orchestrates media generation alongside chat, writes results into your project, and
keeps the output paths local. Each needs a key for the relevant provider (BYOK).

All generated assets land under `codegoblin-output/` in the current project
(`codegoblin-output/images`, `.../audio`, etc.).

## Images

```bash
codegoblin image "a goblin tending a mushroom garden, watercolor"
```

In the TUI/web you can also use the `/image` slash command. Supported image providers include
Google (Gemini image), OpenAI (gpt-image), xAI (grok image), and Qwen/DashScope (Wan). Select an
image model first (or pass `--model`), then prompt. Use `--dry-run` to preview the provider,
model, and output path without spending credits:

```bash
codegoblin image --dry-run "test prompt"
```

Image-to-image / editing is supported by passing input images where the provider allows it.

## Audio (speech & music)

```bash
codegoblin audio "Welcome to CodeGoblin"
```

Or `/audio` in the app. ElevenLabs is supported for text-to-speech and music, with controls for
voice, format, stability, similarity, style, speed, language, and seed. List voices for a
connected provider with the audio command's `--list-voices` option. A blank voice lets
CodeGoblin auto-pick.

## 3D models

```bash
codegoblin model3d --help
```

Text-to-3D and image-to-3D are supported via Tripo, producing a GLB you can preview inline in the
web UI. Generation reports credits and elapsed time, and surfaces actionable messages when
credits are exhausted or a task is rejected.

## Notes

- These are **dual-use, key-gated** features — CodeGoblin never sends a request you didn't
  trigger, and tells you when a key is missing instead of failing silently.
- Output paths are constrained to stay inside the current project directory.
- See `codegoblin image --help`, `codegoblin audio --help`, and `codegoblin model3d --help` for
  the full option set.
