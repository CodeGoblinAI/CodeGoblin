/**
 * Serves the web shell. No API, no session, no model — the layout only.
 *
 *   bun src/web/serve.ts   →  http://localhost:4400
 */
import { file } from "bun"
import { fileURLToPath } from "node:url"

// fileURLToPath, not URL.pathname: on Windows the latter yields "/C:/..."
// with a leading slash, which fails to open.
const page = fileURLToPath(new URL("./index.html", import.meta.url))

Bun.serve({
  port: 4400,
  fetch: () => new Response(file(page), { headers: { "content-type": "text/html; charset=utf-8" } }),
})

console.log("CodeGoblin web shell → http://localhost:4400")
