/**
 * Web server.
 *
 * Serves the UI and exposes the same agent the TUI uses, so both surfaces
 * share one implementation rather than drifting apart.
 *
 *   bun run web
 */
import { file } from "bun"
import { fileURLToPath } from "node:url"
import { runAgent, type Message } from "../core/agent"
import { resolveProvider, PROVIDERS } from "../core/providers"
import { apiKey } from "../core/auth"
import * as sessions from "../core/sessions"

// fileURLToPath, not URL.pathname: on Windows the latter yields "/C:/..."
// with a leading slash, which fails to open.
const page = fileURLToPath(new URL("./index.html", import.meta.url))
const root = process.cwd()

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

async function handle(request: Request): Promise<Response> {
  const url = new URL(request.url)

  if (url.pathname === "/api/providers") {
    return json({
      providers: Object.values(PROVIDERS).map((provider) => ({
        id: provider.id,
        label: provider.label,
        model: provider.model,
        ready: Boolean(apiKey(provider.id)),
      })),
    })
  }

  if (url.pathname === "/api/sessions") {
    const all = await sessions.list()
    return json({ sessions: all.map(({ id, title, updated }) => ({ id, title, updated })) })
  }

  if (url.pathname === "/api/session" && request.method === "GET") {
    const session = await sessions.load(url.searchParams.get("id") ?? "")
    return session ? json({ session }) : json({ error: "not found" }, 404)
  }

  if (url.pathname === "/api/chat" && request.method === "POST") {
    const body = (await request.json()) as { text?: string; sessionId?: string; provider?: string }
    const text = (body.text ?? "").trim()
    if (!text) return json({ error: "empty prompt" }, 400)

    const provider = resolveProvider(body.provider)
    const key = apiKey(provider.id)
    if (!key) return json({ error: `No API key for ${provider.label}.` }, 400)

    const session =
      (body.sessionId ? await sessions.load(body.sessionId) : undefined) ?? sessions.create(provider.id)

    if (session.messages.length === 0) {
      session.messages.push({
        role: "system",
        content:
          "You are CodeGoblin, a coding agent. You have tools to read, list and write files " +
          "in the user's working directory. Prefer reading before editing. Be concise.",
      })
    }
    session.messages.push({ role: "user", content: text })

    // Server-sent events: the browser gets the same event stream the TUI sees.
    const stream = new ReadableStream({
      async start(controller) {
        const encoder = new TextEncoder()
        const send = (event: unknown) =>
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}

`))

        send({ type: "session", id: session.id })
        try {
          for await (const event of runAgent({
            provider,
            apiKey: key,
            messages: session.messages as Message[],
            root,
          })) {
            send(event)
          }
          await sessions.save(session)
          send({ type: "saved", id: session.id, title: session.title })
        } catch (error) {
          send({ type: "error", message: error instanceof Error ? error.message : "request failed" })
        } finally {
          controller.close()
        }
      },
    })

    return new Response(stream, {
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" },
    })
  }

  return new Response(file(page), {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  })
}

let server
for (const port of [4400, 4401, 4402, 4403, 0]) {
  try {
    server = Bun.serve({ port, fetch: handle })
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

console.log(`CodeGoblin web -> http://localhost:${server.port}`)
