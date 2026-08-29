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
import { resolveSelection, allSelections, defaultSelection } from "../core/providers"
import { apiKey } from "../core/auth"
import * as sessions from "../core/sessions"
import { Permissions, type Decision } from "../core/permission"

// fileURLToPath, not URL.pathname: on Windows the latter yields "/C:/..."
// with a leading slash, which fails to open.
const page = fileURLToPath(new URL("./index.html", import.meta.url))
const root = process.cwd()

/**
 * Consent, per browser session.
 *
 * The browser answers over a second request rather than the stream, because
 * the stream is one-way. A pending question is held here until it is
 * answered or the turn is abandoned.
 */
const pendingDecisions = new Map<string, (decision: Decision) => void>()
const permissionsBySession = new Map<string, Permissions>()

function permissionsFor(sessionId: string, send: (event: unknown) => void): Permissions {
  const existing = permissionsBySession.get(sessionId)
  if (existing) return existing
  const created = new Permissions(
    (tool, detail) =>
      new Promise<Decision>((resolve) => {
        const id = sessionId + ":" + tool
        pendingDecisions.set(id, resolve)
        send({ type: "permission", id, tool, detail })
      }),
  )
  permissionsBySession.set(sessionId, created)
  return created
}

/**
 * This server hands a model read and write access to the working directory,
 * so it is deliberately hard to reach:
 *
 * - bound to loopback, not 0.0.0.0, so nothing on the LAN can drive it
 * - same-origin only. Without this, any web page you happen to visit could
 *   POST to localhost and make the agent read your files and return the
 *   contents to the page.
 */
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"])

function sameOrigin(request: Request, url: URL): boolean {
  const host = request.headers.get("host") ?? ""
  // Strip the port without a regex; an escaped d is easy to lose in tooling
  // and silently turns this check into deny-everything.
  const hostname = host.includes(":") && !host.startsWith("[") ? host.slice(0, host.lastIndexOf(":")) : host
  if (!LOOPBACK.has(hostname)) return false

  const origin = request.headers.get("origin")
  if (origin) {
    try {
      if (new URL(origin).host !== host) return false
    } catch {
      return false
    }
  }
  return true
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

async function handle(request: Request): Promise<Response> {
  const url = new URL(request.url)

  if (url.pathname.startsWith("/api/") && !sameOrigin(request, url)) {
    return json({ error: "refused: local same-origin requests only" }, 403)
  }

  if (url.pathname === "/api/providers") {
    return json({
      providers: allSelections().map((s) => ({
        id: s.provider.id + "/" + s.model.id,
        label: s.provider.label + " " + s.model.label,
        reasoning: Boolean(s.model.reasoning),
        ready: Boolean(apiKey(s.provider.id)),
      })),
    })
  }

  // The web composer needs the same command set the TUI has, so it comes
  // from one place rather than being duplicated in the browser.
  if (url.pathname === "/api/commands") {
    const models = allSelections().map((s) => ({
      value: "/model " + s.provider.id + "/" + s.model.id,
      hint: s.provider.label + " " + s.model.label,
    }))
    const saved = await sessions.list(20)
    return json({
      commands: [
        { value: "/help", hint: "show these commands" },
        { value: "/new", hint: "start a fresh conversation" },
        { value: "/model", hint: "switch model", expands: true },
        { value: "/resume", hint: "reopen a saved conversation", expands: true },
        { value: "/compact", hint: "summarise to free context" },
      ],
      models,
      sessions: saved.map((entry) => ({ value: "/resume " + entry.id, hint: entry.title })),
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

  if (url.pathname === "/api/session" && request.method === "DELETE") {
    const ok = await sessions.remove(url.searchParams.get("id") ?? "")
    return json({ ok })
  }

  if (url.pathname === "/api/session" && request.method === "PATCH") {
    const body = (await request.json()) as { id?: string; title?: string }
    const ok = await sessions.rename(body.id ?? "", (body.title ?? "").trim() || "Untitled")
    return json({ ok })
  }

  if (url.pathname === "/api/permission" && request.method === "POST") {
    const body = (await request.json()) as { id?: string; decision?: Decision }
    const resolve = pendingDecisions.get(body.id ?? "")
    if (!resolve) return json({ ok: false, error: "no pending request" }, 404)
    pendingDecisions.delete(body.id!)
    resolve(body.decision === "allow" ? "allow" : "deny")
    return json({ ok: true })
  }

  if (url.pathname === "/api/chat" && request.method === "POST") {
    const body = (await request.json()) as { text?: string; sessionId?: string; provider?: string }
    const text = (body.text ?? "").trim()
    if (!text) return json({ error: "empty prompt" }, 400)

    const selection = resolveSelection(body.provider) ?? defaultSelection()
    const { provider, model } = selection
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

        const encoderPing = new TextEncoder()
        const heartbeat = setInterval(() => {
          try {
            controller.enqueue(encoderPing.encode(": keepalive" + String.fromCharCode(10, 10)))
          } catch {
            clearInterval(heartbeat)
          }
        }, 5000)

        send({ type: "session", id: session.id })
        try {
          for await (const event of runAgent({
            provider,
            modelId: model.id,
            apiKey: key,
            messages: session.messages as Message[],
            root,
            contextWindow: model.contextWindow,
            permissions: permissionsFor(session.id, send),
          })) {
            send(event)
          }
          await sessions.save(session)
          send({ type: "saved", id: session.id, title: session.title })
        } catch (error) {
          send({ type: "error", message: error instanceof Error ? error.message : "request failed" })
        } finally {
          clearInterval(heartbeat)
          controller.close()
        }
      },
    })

    return new Response(stream, {
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" },
    })
  }

  if (url.pathname === "/app.js") {
    return new Response(file(fileURLToPath(new URL("./app.js", import.meta.url))), {
      headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" },
    })
  }

  return new Response(file(page), {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  })
}

let server
for (const port of [4400, 4401, 4402, 4403, 0]) {
  try {
    server = Bun.serve({ port, hostname: "127.0.0.1", idleTimeout: 255, fetch: handle })
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

console.log(`CodeGoblin web -> http://localhost:${server.port}  (loopback only)`)
