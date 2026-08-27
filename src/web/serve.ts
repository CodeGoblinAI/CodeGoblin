/**
 * Serves the web shell. No API, no session, no model - the layout only.
 *
 *   bun run web
 *
 * Picks the next free port if the preferred one is taken, rather than dying
 * with "Is port 4400 in use?" - a stale server from an earlier run should not
 * stop you seeing the UI.
 */
import { file } from "bun"
import { fileURLToPath } from "node:url"

// fileURLToPath, not URL.pathname: on Windows the latter yields "/C:/..."
// with a leading slash, which fails to open.
const page = fileURLToPath(new URL("./index.html", import.meta.url))

const handler = {
  fetch: () =>
    new Response(file(page), {
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
    }),
}

let server
for (const port of [4400, 4401, 4402, 4403, 0]) {
  try {
    server = Bun.serve({ port, ...handler })
    break
  } catch (error) {
    const inUse = error instanceof Error && /in use|EADDRINUSE/i.test(error.message)
    if (!inUse) throw error
    console.log(`port ${port} busy, trying the next one`)
  }
}

if (!server) {
  console.error("Could not bind any port.")
  process.exit(1)
}

console.log(`CodeGoblin web shell -> http://localhost:${server.port}`)
