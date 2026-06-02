## Debugging

- NEVER try to restart the app, or the server process, EVER.

## Local Dev

- `codegoblin web` in source mode serves, in order: embedded UI (after a full build), local `packages/app/dist`, an optional dev-server proxy, or a help page. It no longer proxies upstream OpenCode by default.
- For live UI/CSS work, run the backend and app dev servers separately.
- Backend (from `packages/codegoblin`): `bun run --conditions=browser ./src/index.ts serve --port 4096`
- App (from `packages/app`): `bun dev -- --port 4444`
- Open `http://localhost:4444` to verify UI changes (it targets the backend at `http://localhost:4096`).
- Optional single-port dev proxy: set `CODEGOBLIN_WEB_UI_DEV_URL=http://127.0.0.1:4444` while running `codegoblin web`.

## SolidJS

- Always prefer `createStore` over multiple `createSignal` calls

## Tool Calling

- ALWAYS USE PARALLEL TOOLS WHEN APPLICABLE.

## Browser Automation

Use `agent-browser` for web automation. Run `agent-browser --help` for all commands.

Core workflow:

1. `agent-browser open <url>` - Navigate to page
2. `agent-browser snapshot -i` - Get interactive elements with refs (@e1, @e2)
3. `agent-browser click @e1` / `fill @e2 "text"` - Interact using refs
4. Re-snapshot after page changes
