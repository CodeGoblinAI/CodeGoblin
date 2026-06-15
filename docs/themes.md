# Themes

CodeGoblin ships a goblin-green theme by default and supports switching and customizing the look
in both the TUI and the web UI.

## Switching themes

- **Web UI**: Settings → General → Theme.
- **TUI**: via the settings/theme picker, or set a default in your config.
- **Config**: pin a theme in `codegoblin.json`:

  ```jsonc
  {
    "theme": "codegoblin"
  }
  ```

The `system` setting follows your OS light/dark preference.

## Custom themes

Themes are JSON definitions (token → color). You can add your own and select it the same way as a
built-in. Place custom theme files alongside your config (e.g. under `.codegoblin/`) and reference
the theme by name.

A theme defines colors for the core UI tokens (background, text, primary/accent, muted, borders,
diff add/remove, etc.). The built-in `codegoblin` theme uses the goblin-green primary; start from
it as a template when making your own.

## Tips

- Keep contrast high for the prompt and status lines — they carry the most information.
- The companion/mascot and spend/token animations are theme-aware and driven by real runtime
  state, so they'll pick up your accent color automatically.

For the exact token list and current built-ins, see the theme definitions under
`packages/codegoblin/src/cli/cmd/tui/context/theme/` in the source tree.
