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
import {
  resolveSelection,
  acceptsImages,
  allSelections,
  defaultSelection,
  selectionsByKind,
  kindOf,
  effortFor,
  KIND_LABEL,
  CONNECTABLE,
} from "../core/providers"
import { apiKey } from "../core/auth"
import * as auth from "../core/auth"
import * as sessions from "../core/sessions"
import { Permissions, DECISIONS, type Decision } from "../core/permission"
import { expandMentions } from "../core/mention"
import { globFiles } from "../core/search"
import { History, describe as describeCheckpoint, nothingToDo } from "../core/undo"
import { THEMES, paletteOf } from "../core/theme"
import * as settingsStore from "../core/settings"
import { exportSession } from "../core/export"
import { runMedia, MEDIA_KINDS, withinMediaOutput } from "../core/media"
import {
  MEDIA_OPTIONS,
  optionById,
  withValue,
  loadMedia,
  saveMedia,
  DEFAULT,
} from "../core/media-settings"
import * as memory from "../core/memory"
import { runCommand } from "../core/commands"
import { resolveInside } from "../core/tools"

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

/**
 * Turns that can be cancelled.
 *
 * Aborting the browser fetch only closes the reader; without this the agent
 * kept running server-side, spending tokens on a turn nobody would see.
 */
const activeTurns = new Map<string, AbortController>()
const permissionsBySession = new Map<string, Permissions>()

/**
 * What each session has written, so /undo can put it back.
 *
 * Per session rather than per server: two conversations editing the same tree
 * would otherwise undo each other's work.
 */
const editsBySession = new Map<string, History>()
function editsFor(sessionId: string): History {
  const existing = editsBySession.get(sessionId)
  if (existing) return existing
  const created = new History()
  editsBySession.set(sessionId, created)
  return created
}

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
      providers: selectionsByKind().map((s) => ({
        kind: kindOf(s.model),
        section: KIND_LABEL[kindOf(s.model)],
        id: s.provider.id + "/" + s.model.id,
        label: s.provider.label + " " + s.model.label,
        reasoning: Boolean(s.model.reasoning),
        ready: Boolean(apiKey(s.provider.id)),
        /** Can be shown a picture, as distinct from one that draws them. */
        vision: acceptsImages(s),
      })),
    })
  }

/**
 * The file list behind the @ picker.
 *
 * Walking the tree per keystroke is out of the question, and walking it once
 * for the life of the server would never notice a new file - so it is cached
 * briefly and re-walked when the browser next asks.
 */
let fileList: { files: string[]; at: number } = { files: [], at: 0 }
const FILE_CACHE_MS = 30_000

async function projectFiles(): Promise<string[]> {
  if (Date.now() - fileList.at < FILE_CACHE_MS) return fileList.files
  const files = await globFiles(root, "**/*", 4000).catch(() => [] as string[])
  fileList = { files, at: Date.now() }
  return files
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
        { value: "/clear", hint: "start a fresh conversation" },
        { value: "/model", hint: "switch model", expands: true },
        { value: "/resume", hint: "reopen a saved conversation", expands: true },
        { value: "/compact", hint: "summarise to free context" },
        { value: "/undo", hint: "put back the files the last turn changed" },
        { value: "/redo", hint: "reapply what /undo took back" },
        { value: "/memory", hint: "what is remembered: /memory, /memory add ..., /memory forget <id>" },
        { value: "/connect", hint: "connect a provider - pick one, paste its key", expands: true },
        { value: "/disconnect", hint: "remove a stored key - pick one", expands: true },
        { value: "/status", hint: "what this session is using right now" },
        { value: "/export", hint: "save the conversation as markdown" },
        { value: "/rename", hint: "retitle this conversation" },
        { value: "/theme", hint: "change colours", expands: true },
        { value: "/thinking", hint: "show or hide the model's reasoning" },
        { value: "/effort", hint: "how hard a reasoning model thinks: /effort high", expands: true },
        { value: "/settings", hint: "how generation comes out: /settings 3d.topology quad", expands: true },
      ],
      models,
      sessions: saved.map((entry) => ({ value: "/resume " + entry.id, hint: entry.title })),
      files: await projectFiles(),
      themes: Object.entries(THEMES).map(([name, entry]) => ({
        value: "/theme " + name,
        hint: entry.label,
        palette: entry.palette,
      })),
      settings: await settingsStore.load(),
      mediaOptions: MEDIA_OPTIONS,
      media: await loadMedia(),
      decisions: DECISIONS,
      connectable: CONNECTABLE.map((entry) => ({
        ...entry,
        connected: auth.isConnected(entry.id),
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

  if (url.pathname === "/api/session" && request.method === "DELETE") {
    const ok = await sessions.remove(url.searchParams.get("id") ?? "")
    return json({ ok })
  }

  if (url.pathname === "/api/session" && request.method === "PATCH") {
    const body = (await request.json()) as { id?: string; title?: string }
    const ok = await sessions.rename(body.id ?? "", (body.title ?? "").trim() || "Untitled")
    return json({ ok })
  }

  // Preferences live on the server so the TUI and the browser agree about
  // which theme is current rather than each remembering its own.
  if (url.pathname === "/api/settings" && request.method === "POST") {
    const body = (await request.json()) as { theme?: unknown; thinking?: unknown }
    const current = await settingsStore.load()
    const next = settingsStore.normalise({ ...current, ...body })
    await settingsStore.save(next)
    return json({ settings: next, palette: paletteOf(next.theme) })
  }

  if (url.pathname === "/api/export" && request.method === "POST") {
    const body = (await request.json()) as { sessionId?: string }
    const session = await sessions.load(body.sessionId ?? "")
    if (!session) return json({ message: "nothing to export yet - say something first" })
    try {
      const name = await exportSession(session, root, Date.now())
      return json({ message: "wrote " + name })
    } catch (error) {
      return json({ message: "export failed: " + (error instanceof Error ? error.message : "unknown") }, 500)
    }
  }

  // Generating takes real seconds and is the same work in both surfaces, so
  // the browser asks the server to do it rather than reimplementing any of it.
  // Memory is the same store the TUI writes, so both surfaces remember the
  // same things about the same project.
  /**
   * Connecting a provider.
   *
   * The key crosses one loopback hop from the page to this process and is
   * written to the same file the terminal writes. It is never echoed back,
   * never put in a session, and the listing only ever carries a masked hint.
   */
  if (url.pathname === "/api/connect" && request.method === "GET") {
    return json({ connections: auth.connections(), store: auth.storePath() })
  }

  if (url.pathname === "/api/connect" && request.method === "POST") {
    const body = (await request.json()) as { provider?: string; key?: string }
    const provider = (body.provider ?? "").trim()
    if (!provider) return json({ message: "which provider?" }, 400)
    try {
      await auth.connect(provider, String(body.key ?? ""))
      return json({ message: "connected " + provider })
    } catch (error) {
      return json({ message: error instanceof Error ? error.message : "could not store the key" }, 400)
    }
  }

  if (url.pathname === "/api/connect" && request.method === "DELETE") {
    const provider = url.searchParams.get("provider") ?? ""
    const gone = await auth.disconnect(provider)
    return json({ message: gone ? "disconnected " + provider : "no stored key for " + provider })
  }

  if (url.pathname === "/api/memory" && request.method === "POST") {
    const body = (await request.json()) as { argument?: string; sessionId?: string }
    const parsed = runCommand("/memory " + (body.argument ?? "").trim())
    if (parsed.kind === "message") return json({ message: parsed.text })
    if (parsed.kind !== "memory") return json({ message: "not a memory command" }, 400)
    try {
      if (parsed.action === "add") {
        const entry = await memory.add({ scope: "project", content: parsed.text!, project: root })
        return json({ message: "remembered: " + entry.content })
      }
      if (parsed.action === "forget") {
        const gone = await memory.remove(parsed.text!)
        return json({ message: gone ? "forgotten" : "no memory with that id" })
      }
      if (parsed.action === "clear") {
        const count = await memory.clear()
        return json({ message: count ? "forgot " + count + (count === 1 ? " memory" : " memories") : "nothing to forget" })
      }
      const entries = await memory.list({ project: root, query: parsed.text })
      const NEWLINE = String.fromCharCode(10)
      return json({
        message: entries.length
          ? entries.map((entry) => entry.id + "  " + (entry.pinned ? "* " : "") + entry.content).join(NEWLINE)
          : parsed.text ? "nothing matches" : "nothing remembered yet",
      })
    } catch (error) {
      return json({ message: error instanceof Error ? error.message : "memory failed" })
    }
  }

  /**
   * The generation settings, and the voices an account has.
   *
   * GET hands the page the whole table so it can build the same two-level
   * list the terminal builds; POST changes one. Voices are a separate route
   * because they cost a network call, and a page that never opens the voice
   * list should never pay for it.
   */
  if (url.pathname === "/api/media-settings") {
    if (request.method === "POST") {
      const body = (await request.json()) as { option?: string; value?: string }
      const option = optionById(String(body.option ?? ""))
      if (!option) return json({ ok: false, message: "unknown setting" }, 400)
      const value = String(body.value ?? DEFAULT)
      if (value !== DEFAULT && !option.dynamic && !option.choices.some((choice) => choice.id === value)) {
        return json({ ok: false, message: option.label + " has no " + value }, 400)
      }
      const next = withValue(await loadMedia(), option.id, value)
      await saveMedia(next)
      return json({ ok: true, settings: next })
    }
    return json({ options: MEDIA_OPTIONS, settings: await loadMedia() })
  }

  if (url.pathname === "/api/voices") {
    try {
      const { CodeGoblinAudioCommand } = await import("../domain/audio-command")
      const result = await CodeGoblinAudioCommand.voices({ cwd: root })
      if (!result.ok) return json({ ok: false, message: result.message, voices: [] })
      return json({ ok: true, voices: result.voices.map((voice) => ({ id: voice.id, label: voice.name })) })
    } catch {
      return json({ ok: false, message: "could not reach the voice list", voices: [] })
    }
  }
  if (url.pathname === "/api/media" && request.method === "POST") {
    const body = (await request.json()) as { kind?: string; line?: string; model?: string }
    const kind = MEDIA_KINDS.find((entry) => entry.kind === body.kind)
    if (!kind) return json({ ok: false, message: "unknown media kind" }, 400)
    // The browser sends whichever model the picker is on, so the generator
    // uses the selection rather than a default nobody chose.
    const selected = resolveSelection(body.model)
    const result = await runMedia(
      kind.kind,
      String(body.line ?? ""),
      root,
      { provider: selected?.provider.id, model: selected?.model.id },
      // Read fresh rather than held: the terminal writes the same file, and
      // a page left open overnight should not generate with last night's
      // settings.
      await loadMedia(),
    )
    return json(result)
  }

  /**
   * Serve a generated file back to the page.
   *
   * An image nobody can look at is barely an image, so the browser has to be
   * able to fetch what was just written.
   *
   * Confined to the media output directory rather than the working tree. The
   * first version allowed anything resolveInside allowed, which meant this
   * would happily hand over .git/config - a file that quite often has a token
   * in a remote URL. This endpoint exists to show generated media and now it
   * can do nothing else.
   */
  if (url.pathname === "/api/file" && request.method === "GET") {
    const target = url.searchParams.get("path") ?? ""
    let absolute: string
    try {
      absolute = resolveInside(root, target)
    } catch {
      return json({ error: "outside the working directory" }, 403)
    }
    if (!withinMediaOutput(root, absolute)) {
      return json({ error: "only generated media is served here" }, 403)
    }
    const handle = file(absolute)
    if (!(await handle.exists())) return json({ error: "not found" }, 404)
    return new Response(handle, { headers: { "cache-control": "no-store" } })
  }
  if (url.pathname === "/api/undo" && request.method === "POST") {
    const body = (await request.json()) as { sessionId?: string; direction?: string }
    const edits = editsBySession.get(body.sessionId ?? "")
    const forward = body.direction === "redo"
    if (!edits) return json({ message: "nothing to undo - no file has been changed this session" })
    try {
      const checkpoint = forward ? await edits.redo(root) : await edits.undo(root)
      if (!checkpoint) return json({ message: nothingToDo(edits, forward) })
      return json({ message: (forward ? "redid " : "undid ") + describeCheckpoint(checkpoint) })
    } catch (error) {
      return json({ message: "undo failed: " + (error instanceof Error ? error.message : "unknown") }, 500)
    }
  }

  if (url.pathname === "/api/stop" && request.method === "POST") {
    const body = (await request.json()) as { sessionId?: string }
    const controller = activeTurns.get(body.sessionId ?? "")
    if (controller) {
      controller.abort()
      activeTurns.delete(body.sessionId ?? "")
      // Unblock a turn waiting on consent, or it will hang forever.
      for (const [id, resolve] of pendingDecisions) {
        if (id.startsWith((body.sessionId ?? "") + ":")) { resolve("reject"); pendingDecisions.delete(id) }
      }
      return json({ ok: true })
    }
    return json({ ok: false, error: "no turn running" }, 404)
  }

  if (url.pathname === "/api/permission" && request.method === "POST") {
    const body = (await request.json()) as { id?: string; decision?: Decision }
    const resolve = pendingDecisions.get(body.id ?? "")
    if (!resolve) return json({ ok: false, error: "no pending request" }, 404)
    pendingDecisions.delete(body.id!)
    // Anything unrecognised is a refusal: a malformed answer must never be
    // read as consent.
    resolve(DECISIONS.some((d) => d.id === body.decision) ? body.decision! : "reject")
    return json({ ok: true })
  }

  if (url.pathname === "/api/chat" && request.method === "POST") {
    const body = (await request.json()) as {
      text?: string
      sessionId?: string
      provider?: string
      /** Pictures the page attached, already data URLs. */
      images?: { name?: string; dataUrl?: string }[]
    }
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
    // Mentions are read here, so the stored message carries its files and a
    // resumed conversation still has the context it was answered with.
    const mentioned = await expandMentions(text, root)

    // Pictures arrive two ways and mean the same thing once they are here:
    // attached in the page, or @mentioned by path like any other file.
    const pasted = (body.images ?? [])
      .filter((image) => typeof image?.dataUrl === "string" && image.dataUrl.startsWith("data:image/"))
      .slice(0, 10)
      .map((image) => ({ name: String(image.name ?? "image"), dataUrl: String(image.dataUrl) }))
    const images = [...pasted, ...mentioned.images]

    session.messages.push(
      mentioned.files.length || images.length
        ? { role: "user", content: mentioned.content, display: text, images }
        : { role: "user", content: text },
    )

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

        const turn = new AbortController()
        activeTurns.set(session.id, turn)

        send({ type: "session", id: session.id })
        // One checkpoint per turn, so undo takes back the whole answer.
        const edits = editsFor(session.id)
        edits.begin(text)
        // Say what was attached: a mention that silently did nothing and a
        // mention that worked would otherwise look exactly the same.
        if (mentioned.files.length) send({ type: "attached", files: mentioned.files })
        try {
          for await (const event of runAgent({
            provider,
            modelId: model.id,
            apiKey: key,
            messages: session.messages as Message[],
            root,
            contextWindow: model.contextWindow,
            images: acceptsImages(selection),
            permissions: permissionsFor(session.id, send),
            memory: await memory.recall({ project: root, session: session.id }),
            history: edits,
            effort: effortFor(model, (await settingsStore.load()).effort),
            signal: turn.signal,
          })) {
            send(event)
          }
          await sessions.save(session)
          send({ type: "saved", id: session.id, title: session.title })
        } catch (error) {
          send({ type: "error", message: error instanceof Error ? error.message : "request failed" })
        } finally {
          edits.commit()
          clearInterval(heartbeat)
          activeTurns.delete(session.id)
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
