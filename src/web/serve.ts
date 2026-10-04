/**
 * Web server.
 *
 * Serves the UI and exposes the same agent the TUI uses, so both surfaces
 * share one implementation rather than drifting apart.
 *
 *   bun run web
 */
import { file } from "bun"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { localChatMessages, runAgent, type Message } from "../core/agent"
import { cliStatuses } from "../core/cli-status"
import { resolveStartupModel } from "../core/model-selection"
import { cliHandoff } from "../core/cli-handoff"
import { fetchBalance, balanceRows } from "../core/balance"
import { codexAccount, cachedCodexAccount, accountRows, startCodexLogin } from "../core/codex-account"
import { startCursorLogin } from "../core/cursor-sdk"
import { subscriptionAccount, cachedSubscriptionAccount, subscriptionRows } from "../core/subscription-account"
import { listCodexSessions, importCodexSession } from "../core/codex-import"
import { addSpend, priceOf, usage } from "../core/context"
import {
  PROVIDERS,
  resolveSelection,
  acceptsImages,
  allSelections,
  defaultSelection,
  selectionsByKind,
  kindOf,
  effortFor,
  takesEffort,
  exactSelection,
  KIND_LABEL,
  CONNECTABLE,
} from "../core/providers"
import { apiKey } from "../core/auth"
import * as auth from "../core/auth"
import * as sessions from "../core/sessions"
import { DECISIONS, MODES, askedFor, refusalLabel, type Decision, type PermissionMode, type Permissions } from "../core/permission"
import { BrowserConsent } from "./consent"
import { McpManager } from "../core/mcp"
import { SubagentManager, type SubagentContext } from "../core/subagents"
import { configPath, checkpointEvery } from "../core/config"
import { customCommands, invocationItems, resolveInvocation } from "../core/invocations"
import { listSkills, skillIndex } from "../core/skills"
import { systemPrompt } from "../core/system-prompt"
import { expandMentions } from "../core/mention"
import { globFiles } from "../core/search"
import { History, describe as describeCheckpoint, nothingToDo } from "../core/undo"
import { changesIn, summarise } from "../core/changes"
import { THEMES, paletteOf } from "../core/theme"
import * as settingsStore from "../core/settings"
import { exportSession } from "../core/export"
import { runMedia, MEDIA_KINDS, withinMediaOutput } from "../core/media"
import {
  MEDIA_OPTIONS,
  optionsForModel,
  withValue,
  requireMediaSetting,
  loadMedia,
  saveMedia,
  DEFAULT,
} from "../core/media-settings"
import * as memory from "../core/memory"
import { runCommand, COMMANDS, COMMAND_ALIASES, PENDING_COMMANDS } from "../core/commands"
import { resolveInside } from "../core/tools"

// fileURLToPath, not URL.pathname: on Windows the latter yields "/C:/..."
// with a leading slash, which fails to open.
const page = fileURLToPath(new URL("./index.html", import.meta.url))
const root = process.cwd()

/** Consent for every browser conversation; web/consent.ts says why it lives there. */
const consent = new BrowserConsent()

/**
 * The page sends its mode, and whether it is planning, with every message;
 * neither is kept between messages here. Anything unrecognised is Ask for
 * approval, never something that asks less.
 */
function withMode(permissions: Permissions, body: { mode?: string; planning?: boolean }): Permissions {
  permissions.mode = MODES.some((entry) => entry.id === body.mode) ? (body.mode as PermissionMode) : "ask"
  permissions.planning = body.planning === true
  return permissions
}

/**
 * MCP servers from codegoblin.jsonc, one set for every browser conversation,
 * connected in the background from startup. /mcp says how each is doing.
 */
const mcp = McpManager.fromConfig()
void mcp.start()

/**
 * Background subagents, one manager per browser conversation. Each message
 * refreshes what they work under - model, permissions, the stream to send on -
 * and a turn waits for its subagents before it ends, so there is always a
 * stream open for their events.
 */
const subagentsBySession = new Map<string, SubagentManager>()
const subagentContexts = new Map<string, SubagentContext>()

/**
 * Turns that can be cancelled.
 *
 * Aborting the browser fetch only closes the reader; without this the agent
 * kept running server-side, spending tokens on a turn nobody would see.
 */
const activeTurns = new Map<string, AbortController>()
const codexLogins = new Map<string, Awaited<ReturnType<typeof startCodexLogin>>>()
let codexLoginsStarting = 0
const cursorLogins = new Map<string, Awaited<ReturnType<typeof startCursorLogin>>>()
let cursorLoginsStarting = 0

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
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } })

let fileList: { files: string[]; at: number } = { files: [], at: 0 }
let fileWalk: Promise<string[]> | undefined
async function projectFiles(force = false): Promise<string[]> {
  if (fileWalk) return fileWalk
  if (!force && Date.now() - fileList.at < 1000) return fileList.files
  fileWalk = globFiles(root, "**/*", 4000).then((files) => {
    fileList = { files, at: Date.now() }
    return files
  }).catch(() => fileList.files).finally(() => { fileWalk = undefined })
  return fileWalk
}

async function handle(request: Request): Promise<Response> {
  const url = new URL(request.url)

  if (url.pathname.startsWith("/api/") && !sameOrigin(request, url)) {
    return json({ error: "refused: local same-origin requests only" }, 403)
  }

  if (url.pathname === "/api/codex/account" && request.method === "GET") {
    const cached = url.searchParams.get("cached") === "1"
    const snapshot = cached ? await cachedCodexAccount() : await codexAccount()
    const response = json(snapshot ? { ...snapshot, rows: accountRows(snapshot) } : { rows: [["Codex account", "No cached snapshot; refresh to check"]] })
    response.headers.set("cache-control", "no-store")
    return response
  }
  if (url.pathname === "/api/subscription/account" && request.method === "GET") {
    const source = url.searchParams.get("source")
    if (source !== "claude" && source !== "cursor") return json({message:"Unknown subscription source"},400)
    const snapshot = url.searchParams.get("cached") === "1" ? await cachedSubscriptionAccount(source) : await subscriptionAccount(source)
    const response = json(snapshot ? {...snapshot,rows:subscriptionRows(snapshot)} : {rows:[["account","No cached snapshot; refresh to check"]]})
    response.headers.set("cache-control","no-store")
    return response
  }
  if (url.pathname === "/api/codex/login") {
    if (request.method === "GET") return json({ state: codexLogins.get(url.searchParams.get("id") || "")?.status() || "expired" })
    if (request.method === "POST") {
      if (codexLogins.size + codexLoginsStarting >= 2) return json({ message: "Finish or cancel the existing sign-in first" }, 409)
      codexLoginsStarting++
      try {
        const login = await startCodexLogin()
        const id = crypto.randomUUID()
        codexLogins.set(id, login)
        setTimeout(() => { codexLogins.delete(id); void login.cancel() }, 5 * 60_000).unref()
        return json({ id, url: login.url, expiresAt: login.expiresAt })
      } catch { return json({ message: "Could not start official Codex sign-in; run codex login" }, 503) }
      finally { codexLoginsStarting-- }
    }
    if (request.method === "DELETE") {
      const id = url.searchParams.get("id") || ""
      const login = codexLogins.get(id)
      codexLogins.delete(id)
      await login?.cancel()
      return json({ cancelled: true })
    }
  }
  if (url.pathname === "/api/cursor/login") {
    if (request.method === "GET") return json({ state: cursorLogins.get(url.searchParams.get("id") || "")?.status() || "expired" })
    if (request.method === "POST") {
      if (cursorLogins.size + cursorLoginsStarting >= 2) return json({ message: "Finish or cancel the existing sign-in first" }, 409)
      cursorLoginsStarting++
      try {
        const login = await startCursorLogin()
        const id = crypto.randomUUID()
        cursorLogins.set(id, login)
        setTimeout(() => { cursorLogins.delete(id); void login.cancel() }, 5 * 60_000).unref()
        return json({ id, url: login.url, expiresAt: login.expiresAt })
      } catch { return json({ message: "Could not start Cursor SDK sign-in; check SDK compatibility" }, 503) }
      finally { cursorLoginsStarting-- }
    }
    if (request.method === "DELETE") {
      const id = url.searchParams.get("id") || ""
      const login = cursorLogins.get(id)
      cursorLogins.delete(id)
      await login?.cancel()
      return json({ cancelled: true })
    }
  }
  if (url.pathname === "/api/codex/import") {
    try {
      if (request.method === "GET") return json(await listCodexSessions(root, url.searchParams.get("cursor") || undefined))
      if (request.method === "POST") {
        const body = await request.json() as { id?: string; model?: string }
        const selected = exactSelection(String(body.model || ""))
        if (!selected || kindOf(selected.model) !== "text") return json({ message: "Select a text model before importing" }, 400)
        const imported = await importCodexSession(String(body.id || ""), root, selected.provider.id)
        return json({ ...imported, message: "Imported a new text conversation; tools, images, reasoning and hidden prompts were omitted. Source untouched." })
      }
    } catch { return json({ message: "Could not read/import this project's Codex conversation; check CLI compatibility and selected session" }, 400) }
  }

  if (url.pathname === "/api/cli/login" && request.method === "GET") {
    const source = url.searchParams.get("source")
    return source === "claude" || source === "cursor" ? json(cliHandoff(source)) : json({ message: "Unknown CLI sign-in handoff" }, 400)
  }
  if (url.pathname === "/api/providers") {
    const cli = await cliStatuses()
    return json({
      providers: selectionsByKind().map((s) => ({
        kind: kindOf(s.model),
        section: KIND_LABEL[kindOf(s.model)],
        id: s.provider.id + "/" + s.model.id,
        label: s.provider.label + " " + s.model.label,
        reasoning: Boolean(s.model.reasoning),
        effort: takesEffort(s.model),
        ready: s.provider.cli ? cli[s.provider.id]?.ready === true : apiKey(s.provider.id) !== undefined,
        connectionHint: s.provider.cli ? cli[s.provider.id]?.detail : undefined,
        /** Can be shown a picture, as distinct from one that draws them. */
        vision: acceptsImages(s),
        /**
         * The settings this model takes, by id.
         *
         * Sent with the model rather than worked out in the browser, so the rule
         * about which knobs belong to which model lives in one file.
         */
        settings: optionsForModel(s.provider.id, s.model.id).map((option) => option.id),
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
  if (url.pathname === "/api/files") return json({ files: await projectFiles(url.searchParams.get("refresh") === "1") })

  // The web composer needs the same command set the TUI has, so it comes
  // from one place rather than being duplicated in the browser.
  if (url.pathname === "/api/commands") {
    const models = allSelections().map((s) => ({
      value: "/model " + s.provider.id + "/" + s.model.id,
      hint: s.provider.label + " " + s.model.label,
    }))
    const saved = await sessions.list(20)
    return json({
      project: path.basename(root),
      commands: [
        ...COMMANDS.filter((c) => !["/quit"].includes(c.name)).map((c) => ({ value: c.name, hint: c.description, expands: ["/model", "/resume", "/connect", "/disconnect", "/theme", "/effort"].includes(c.name) })),
        // Marked, so the page sends them to the model rather than calling them unknown.
        ...invocationItems(root).map((item) => ({ ...item, invocation: true })),
      ],
      models,
      aliases: COMMAND_ALIASES,
      pending: PENDING_COMMANDS,
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
      modes: MODES,
      checkpoint: checkpointEvery(),
      connectable: CONNECTABLE.map((entry) => ({
        ...entry,
        env: auth.envVariable(entry.id),
        connected: auth.isConnected(entry.id),
      })),
    })
  }

  if (url.pathname === "/api/skills") {
    return json({
      skills: listSkills(root).map(({ name, description, scope, modelInvocable, userInvocable }) => ({
        name,
        description,
        scope,
        modelInvocable,
        userInvocable,
      })),
      commands: customCommands(root).map(({ name, description, scope }) => ({ name, description, scope })),
    })
  }

  if (url.pathname === "/api/mcp") {
    return json({ servers: mcp.statuses(), config: configPath() })
  }

  if (url.pathname === "/api/sessions") {
    const all = await sessions.list()
    return json({ sessions: all.map(({ id, title, updated }) => ({ id, title, updated })) })
  }

  if (url.pathname === "/api/session" && request.method === "GET") {
    const session = await sessions.load(url.searchParams.get("id") ?? "")
    const resolved = session ? await resolveStartupModel(session.model ? session.provider + "/" + session.model : session.provider) : undefined
    const selected = resolved && kindOf(resolved.model) === "text" ? resolved : undefined
    return session ? json({
      session,
      selection: selected ? selected.provider.id + "/" + selected.model.id : undefined,
      context: selected ? usage(selected.provider.local && !selected.provider.localTools ? localChatMessages(session.messages) : session.messages, selected.model.contextWindow) : undefined,
    }) : json({ error: "not found" }, 404)
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
    const body = (await request.json()) as { sessionId?: string; path?: unknown }
    if (body.path !== undefined && typeof body.path !== "string") return json({ message: "export path must be text" }, 400)
    const session = await sessions.load(body.sessionId ?? "")
    if (!session) return json({ message: "nothing to export yet - say something first" })
    try {
      const name = await exportSession(session, root, Date.now(), body.path)
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

  if (url.pathname === "/api/balance" && request.method === "GET") {
    const provider = url.searchParams.get("provider") ?? ""
    if (!Object.hasOwn(PROVIDERS, provider)) return json({ message: "Unknown provider" }, 400)
    const snapshot = await fetchBalance(provider, apiKey(provider))
    const response = json({ ...snapshot, rows: balanceRows(snapshot) })
    response.headers.set("cache-control", "no-store")
    return response
  }

  if (url.pathname === "/api/connect" && request.method === "POST") {
    const body = (await request.json()) as { provider?: string; key?: string }
    const provider = (body.provider ?? "").trim()
    if (provider === "cursor") return json({ message: "Use /login cursor for SDK user-plan sign-in, or /connect cursor-api for an existing key" }, 400)
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
    if (provider === "cursor") return json({ message: "Revoke the SDK user-plan key in Cursor's account dashboard; /disconnect cursor-api only removes a CG-stored API key" }, 400)
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
      const body = (await request.json()) as { option?: string; value?: string; model?: string }
      // A value belongs to a model, so saving one without saying which model is
      // saving it nowhere - refuse rather than guess.
      const named = typeof body.model === "string" ? body.model.trim() : ""
      // Exactly the model named, or nowhere. The forgiving resolver would pick
      // the default for nothing at all and write this onto a model nobody chose.
      const selected = exactSelection(named)
      if (!selected) return json({ ok: false, message: named ? "no such model: " + named : "which model?" }, 400)
      const value = String(body.value ?? DEFAULT)
      const id = String(body.option ?? "")
      try {
        requireMediaSetting(selected.provider.id, selected.model.id, id, value)
      } catch (error) {
        return json({ ok: false, message: error instanceof Error ? error.message : "Invalid setting" }, 400)
      }
      const next = withValue(await loadMedia(), selected.provider.id, selected.model.id, id, value)
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

  if (url.pathname === "/api/diff" && request.method === "GET") {
    const id = url.searchParams.get("sessionId") ?? ""
    const edits = editsBySession.get(id)
    if (!edits) return json({ files: [], added: 0, removed: 0, message: id ? "No edit history is available for this conversation in this server run." : "No conversation is selected." })
    const changes = await changesIn(root, edits)
    return json({ ...changes, message: summarise(changes) })
  }

  if (url.pathname === "/api/stop" && request.method === "POST") {
    const body = (await request.json()) as { sessionId?: string }
    const controller = activeTurns.get(body.sessionId ?? "")
    if (controller) {
      controller.abort()
      subagentsBySession.get(body.sessionId ?? "")?.stopAll()
      activeTurns.delete(body.sessionId ?? "")
      // Unblock a turn waiting on consent, or it will hang forever.
      consent.abandon(body.sessionId ?? "")
      return json({ ok: true })
    }
    return json({ ok: false, error: "no turn running" }, 404)
  }

  if (url.pathname === "/api/mode" && request.method === "POST") {
    const body = await request.json() as { sessionId?: string; mode?: string }
    if (!MODES.some((mode) => mode.id === body.mode)) return json({ ok: false, error: "invalid mode" }, 400)
    const ok = consent.setMode(body.sessionId ?? "", body.mode as PermissionMode)
    return json({ ok }, ok ? 200 : 404)
  }

  if (url.pathname === "/api/permission" && request.method === "POST") {
    const body = (await request.json()) as { id?: string; decision?: Decision }
    // answer() refuses anything unrecognised, so a malformed answer can never
    // be read as consent.
    if (!consent.answer(body.id ?? "", body.decision)) {
      return json({ ok: false, error: "no pending request" }, 404)
    }
    return json({ ok: true })
  }

  if (url.pathname === "/api/chat" && request.method === "POST") {
    const body = (await request.json()) as {
      text?: string
      sessionId?: string
      provider?: string
      /** Pictures the page attached, already data URLs. */
      images?: { name?: string; dataUrl?: string }[]
      /** Ask for approval, Approve for me or Full access - ask when missing. */
      mode?: string
      planning?: boolean
      /** Subagents are offered only when the page asks for them with /boost. */
      boost?: boolean
    }
    const text = (body.text ?? "").trim()
    if (!text) return json({ error: "empty prompt" }, 400)

    const selection = body.provider ? await resolveStartupModel(body.provider) : defaultSelection()
    if (!selection || kindOf(selection.model) !== "text") return json({ error: "Requested chat model is unavailable; choose a model before continuing." }, 400)
    const { provider, model } = selection
    const key = apiKey(provider.id)
    if (key === undefined) return json({ error: `No API key for ${provider.label}.` }, 400)

    const session =
      (body.sessionId ? await sessions.load(body.sessionId) : undefined) ?? sessions.create(provider.id, model.id)
    session.provider = provider.id
    session.model = model.id

    if (session.messages.length === 0) {
      session.messages.push({
        role: "system",
        content: systemPrompt("browser"),
      })
    }
    // Mentions are read here, so the stored message carries its files and a
    // resumed conversation still has the context it was answered with.
    // A custom command or a skill is sent as its text; the line typed is what is shown.
    const invoked = text.startsWith("/") ? resolveInvocation(text, root) : undefined
    const mentioned = await expandMentions(invoked ? invoked.content : text, root)

    // Pictures arrive two ways and mean the same thing once they are here:
    // attached in the page, or @mentioned by path like any other file.
    const pasted = (body.images ?? [])
      .filter((image) => typeof image?.dataUrl === "string" && image.dataUrl.startsWith("data:image/"))
      .slice(0, 10)
      .map((image) => ({ name: String(image.name ?? "image"), dataUrl: String(image.dataUrl) }))
    const images = [...pasted, ...mentioned.images]

    session.messages.push(
      mentioned.files.length || images.length || invoked
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
        const permissions = withMode(consent.forSession(session.id, send), body)
        // Register live controls before waiting for external servers to start.
        await mcp.settled(10_000)
        subagentContexts.set(session.id, {
          provider,
          modelId: model.id,
          apiKey: key,
          root,
          where: "browser",
          contextWindow: model.contextWindow,
          permissions,
          history: edits,
          mcp,
          instructions: [skillIndex(listSkills(root)), mcp.notice()].filter(Boolean).join(String.fromCharCode(10, 10)) || undefined,
          effort: effortFor(model, (await settingsStore.load()).effort),
        })
        let subagents = subagentsBySession.get(session.id)
        if (!subagents) {
          const id = session.id
          subagents = new SubagentManager(() => subagentContexts.get(id)!)
          subagentsBySession.set(id, subagents)
        }
        subagents.onEvent = (event) =>
          send(
            event.type === "subagent_event" && event.event.type === "tool_denied"
              ? { ...event, event: { ...event.event, label: refusalLabel(event.event) } }
              : event,
          )
        try {
          for await (const event of runAgent({
            provider,
            modelId: model.id,
            apiKey: key,
            messages: session.messages as Message[],
            root,
            contextWindow: model.contextWindow,
            images: acceptsImages(selection),
            permissions,
            // Offered only with /boost - or while subagents started under it are still out.
            subagents: body.boost === true || subagents.running().length ? subagents : undefined,
            extraTools: mcp,
            memory: await memory.recall({ project: root, session: session.id }),
            // Servers that are configured but down are named, so the model says so
            // rather than reaching for an unrelated tool in their place.
            instructions: [skillIndex(listSkills(root)), mcp.notice()].filter(Boolean).join(String.fromCharCode(10, 10)) || undefined,
            history: edits,
            effort: effortFor(model, (await settingsStore.load()).effort),
            signal: turn.signal,
          })) {
            // A refused call carries who refused it; the label is composed here
            // so the browser and the terminal say the same words about it.
            if (event.type === "spend") {
              session.spend = addSpend(session.spend ?? { input: 0, output: 0 }, { ...event, dollars: priceOf(event, model.price) })
            }
            send(
              event.type === "tool_denied" ? { ...event, label: refusalLabel(event) }
                // The row says which file, not the raw JSON that cut the path off.
                : event.type === "tool_start" ? { ...event, asked: askedFor(event.name, event.args) }
                : event,
            )
            if (event.type === "spend" || event.type === "turn_end") send({
              type: "usage",
              spend: session.spend,
              context: usage(provider.local && !provider.localTools ? localChatMessages(session.messages) : session.messages, model.contextWindow),
            })
          }
          await sessions.save(session)
          send({ type: "saved", id: session.id, title: session.title })
        } catch (error) {
          // Stopping mid-stream throws out of the loop. The TUI keeps the
          // conversation when that happens; here it used to vanish - the
          // prompt never reached Sessions and could not be resumed. A stop
          // is also not an error worth reporting.
          if (turn.signal.aborted) await sessions.save(session).catch(() => {})
          else send({ type: "error", message: error instanceof Error ? error.message : "request failed" })
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

// MCP servers started as child processes go when this server does.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void Promise.all([mcp.close(), ...[...codexLogins.values(), ...cursorLogins.values()].map((login) => login.cancel())]).finally(() => process.exit(0))
  })
}
