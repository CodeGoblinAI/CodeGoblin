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
import { isLocalChat } from "../core/local-provider"
import { findEngine, ownedModelsDir } from "../core/local-runtime"
import { LOCAL_CATALOG, currentDownload, downloadModel, gb as gbOf, isInstalled, lastDownload, progressText } from "../core/local-downloads"
import { localCommand } from "../core/local-command"
import { resolveStartupModel } from "../core/model-selection"
import { cliHandoff } from "../core/cli-handoff"
import { fetchBalance, balanceRows } from "../core/balance"
import { codexAccount, cachedCodexAccount, accountRows, startCodexLogin } from "../core/codex-account"
import { startCursorLogin } from "../core/cursor-sdk"
import { subscriptionAccount, cachedSubscriptionAccount, subscriptionRows } from "../core/subscription-account"
import { IMPORTERS, importSource } from "../core/conversation-import"
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
  effortLevels,
  effortProblem,
  takesEffort,
  exactSelection,
  pickerSection,
  refreshExperientialModels,
  refreshLiveModels,
  refreshCatalog,
  activateCatalog,
  CONNECTABLE,
  connectChoices,
} from "../core/providers"
import { apiKey } from "../core/auth"
import * as auth from "../core/auth"
import * as sessions from "../core/sessions"
import { normaliseActivity, recordActivity } from "../core/session-activity"
import { DECISIONS, MODES, Permissions, askedFor, refusalLabel, type Decision, type PermissionMode } from "../core/permission"
import { runTypedCommand, typedCommand } from "../core/user-shell"
import { BrowserConsent } from "./consent"
import { McpManager, withoutServers } from "../core/mcp"
import { SubagentManager, agentMention, listAgents, selectedAgent, agentSelection, type SubagentContext } from "../core/subagents"
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
import { endTerminal, releaseTerminal, reserveTerminal, startTerminal, terminalMessage, type TerminalSocket } from "./terminal"
import { isDirectory, recentProjects, rememberProject, sameFolder } from "../core/projects"
import { createWorktree, currentBranch, listWorktrees, localBranches, removeWorktree, repoRoot, switchBranch } from "../core/worktrees"
import { markRecent, pickerRows, toggleFavourite } from "../core/favourites"
import { exportSession, sessionMarkdown } from "../core/export"
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
/**
 * The project this server works in. It starts as the folder it was launched
 * from and changes with the project switcher; the process's own working
 * directory follows it, so everything that reads process.cwd() agrees.
 */
let root = process.cwd()
rememberProject(root)

/** Opens another project: only between turns, and only an existing folder. */
function switchProject(target: string): string | undefined {
  if (activeTurns.size) return "an answer is still running; switch once it finishes"
  const resolved = path.resolve(target)
  if (!isDirectory(resolved)) return "no such folder: " + target
  process.chdir(resolved)
  root = resolved
  // Undo history and the file list belong to the old tree.
  editsBySession.clear()
  fileList = { files: [], at: 0 }
  rememberProject(root)
  return undefined
}

function projectInfo() {
  const repo = repoRoot(root)
  return {
    current: { path: root, name: path.basename(root) || root, branch: repo ? currentBranch(root) : undefined, repo: Boolean(repo) },
    recent: recentProjects().filter((project) => !sameFolder(project.path, root)).slice(0, 12),
    worktrees: repo ? listWorktrees(root) : [],
    branches: repo ? localBranches(root) : [],
  }
}

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
// Experiential Labs' list changes often; read it live once, without holding up startup.
void refreshExperientialModels()
void refreshLiveModels(apiKey)
// models.dev: every provider for /connect, and the ones with a key in the picker.
void refreshCatalog(apiKey)
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
type ActiveTurn = { controller: AbortController; done: Promise<void> }
const activeTurns = new Map<string, ActiveTurn>()
const codexLogins = new Map<string, Awaited<ReturnType<typeof startCodexLogin>>>()
let codexLoginsStarting = 0
const cursorLogins = new Map<string, Awaited<ReturnType<typeof startCursorLogin>>>()
const mcpLogins = new Map<string, Awaited<ReturnType<McpManager["login"]>>>()
let mcpLoginsStarting = 0
let cursorLoginsStarting = 0

/**
 * What each session has written, so /undo can put it back.
 *
 * Per session rather than per server: two conversations editing the same tree
 * would otherwise undo each other's work.
 */
const editsBySession = new Map<string, History>()
/** MCP servers switched off before a conversation is first saved, by session id ("" for a new one). */
const pendingMcpOff = new Map<string, string[]>()
function editsFor(sessionId: string, review?: unknown): History {
  const existing = editsBySession.get(sessionId)
  if (existing) return existing
  const created = new History()
  created.restoreReview(root, review)
  editsBySession.set(sessionId, created)
  return created
}

async function saveReviewSession(session: sessions.Session) {
  session.review = editsFor(session.id, session.review).reviewState(root)
  session.activity = normaliseActivity(session.activity, true)
  await sessions.save(session)
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

/** The xterm.js files the terminal panel loads, served from node_modules and nothing else. */
const VENDOR: Record<string, { file: string; type: string }> = {
  "/vendor/xterm.js": { file: "../../node_modules/@xterm/xterm/lib/xterm.js", type: "text/javascript; charset=utf-8" },
  "/vendor/xterm.css": { file: "../../node_modules/@xterm/xterm/css/xterm.css", type: "text/css; charset=utf-8" },
  "/vendor/addon-fit.js": { file: "../../node_modules/@xterm/addon-fit/lib/addon-fit.js", type: "text/javascript; charset=utf-8" },
}

async function handle(request: Request, server?: Bun.Server<TerminalSocket["data"]>): Promise<Response | undefined> {
  const url = new URL(request.url)

  // The terminal: a WebSocket that must come from this page itself. Same
  // origin as every other API call, and an Origin header is required - a
  // browser always sends one on a WebSocket, so its absence means it is not
  // this page asking.
  if (url.pathname === "/api/terminal") {
    if (!sameOrigin(request, url) || !request.headers.get("origin")) return json({ error: "refused: local same-origin requests only" }, 403)
    if (!reserveTerminal()) return json({ error: "too many terminals open" }, 429)
    const cols = Number(url.searchParams.get("cols")) || 100
    const rows = Number(url.searchParams.get("rows")) || 30
    if (server?.upgrade(request, { data: { cwd: root, cols, rows, reserved: true } as TerminalSocket["data"] & { cols: number; rows: number } })) return undefined
    releaseTerminal()
    return json({ error: "a terminal needs a WebSocket" }, 400)
  }
  if (VENDOR[url.pathname]) {
    const entry = VENDOR[url.pathname]!
    return new Response(file(fileURLToPath(new URL(entry.file, import.meta.url))), { headers: { "content-type": entry.type, "cache-control": "max-age=3600" } })
  }

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
  // /api/codex/import is the original path; /api/import?source= serves every importer.
  if (url.pathname === "/api/import" || url.pathname === "/api/codex/import") {
    const source = url.pathname === "/api/codex/import" ? "codex" : importSource(url.searchParams.get("source") ?? undefined)
    if (!source) return json({ message: "Unknown import source" }, 400)
    const importer = IMPORTERS[source]
    try {
      if (request.method === "GET") return json(await importer.list(root, url.searchParams.get("cursor") || undefined))
      if (request.method === "POST") {
        const body = await request.json() as { id?: string; model?: string }
        const selected = exactSelection(String(body.model || ""))
        if (!selected || kindOf(selected.model) !== "text") return json({ message: "Select a text model before importing" }, 400)
        const imported = await importer.copy(String(body.id || ""), root, selected.provider.id)
        return json({ ...imported, message: "Imported a new text conversation. " + importer.omitted + ". Source untouched." })
      }
    } catch { return json({ message: "Could not read/import this project's " + importer.label + " conversation; check CLI compatibility and selected session" }, 400) }
  }

  if (url.pathname === "/api/cli/login" && request.method === "GET") {
    const source = url.searchParams.get("source")
    return source === "claude" || source === "cursor" ? json(cliHandoff(source)) : json({ message: "Unknown CLI sign-in handoff" }, 400)
  }
  // Favourites and recents are shared with the terminal through the settings file.
  if (url.pathname === "/api/favourite" && request.method === "POST") {
    const body = (await request.json().catch(() => ({}))) as { id?: unknown }
    if (typeof body.id !== "string" || !exactSelection(body.id)) return json({ message: "Select a model to favourite" }, 400)
    return json(await toggleFavourite(body.id))
  }
  if (url.pathname === "/api/recent" && request.method === "POST") {
    const body = (await request.json().catch(() => ({}))) as { id?: unknown }
    if (typeof body.id !== "string" || !exactSelection(body.id)) return json({ message: "Unknown model" }, 400)
    return json({ recents: await markRecent(body.id) })
  }

  if (url.pathname === "/api/providers") {
    const cli = await cliStatuses()
    const engine = findEngine()
    return json({
      providers: pickerRows(selectionsByKind(), await settingsStore.load()).map(({ selection: s, section, favourite }) => ({
        kind: kindOf(s.model),
        section,
        favourite,
        id: s.provider.id + "/" + s.model.id,
        label: s.provider.label + " " + s.model.label,
        reasoning: Boolean(s.model.reasoning),
        effort: takesEffort(s.model),
        /** This model's own levels and what "auto" means on it - not a shared list. */
        efforts: effortLevels(s.model),
        ...(s.model.defaultEffort ? { defaultEffort: s.model.defaultEffort } : {}),
        ready: s.provider.cli ? cli[s.provider.id]?.ready === true : s.provider.runtime ? Boolean(engine) : apiKey(s.provider.id) !== undefined,
        connectionHint: s.provider.cli ? cli[s.provider.id]?.detail
          : s.provider.runtime ? (engine ? "Runs on this machine; CG-Next starts llama.cpp for it" : "No llama-server found; /local says where to put one") : undefined,
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
    const models = pickerRows(selectionsByKind(), await settingsStore.load()).map(({ selection: s, section, favourite }) => ({
      value: "/model " + s.provider.id + "/" + s.model.id,
      hint: (favourite ? "\u2605 " : "") + section + " \u00b7 " + s.provider.label + " " + s.model.label,
    }))
    const saved = await sessions.list(20, root)
    return json({
      project: path.basename(root),
      commands: [
        ...COMMANDS.filter((c) => !["/quit"].includes(c.name)).map((c) => ({ value: c.name, hint: c.description, expands: ["/model", "/favourite", "/resume", "/connect", "/disconnect", "/theme", "/effort"].includes(c.name) })),
        // Marked, so the page sends them to the model rather than calling them unknown.
        ...invocationItems(root).map((item) => ({ ...item, invocation: true })),
      ],
      agents: listAgents(root).map(({ name, description }) => ({ name, description })),
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
      // What /connect shows before anything is typed: built-ins, featured and connected providers.
      connectShort: connectChoices("", (id) => auth.isConnected(id)),
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
  if (url.pathname === "/api/agents" && request.method === "GET") return json({agents:listAgents(root).map(({name,description,source,model,tools})=>({name,description,source,model,tools}))})
  if (url.pathname === "/api/agent/selection" && request.method === "POST") {
    const body=await request.json() as {name?:string;model?:string}
      if (typeof body.name !== "string" || body.name.length > 128 || typeof body.model !== "string") return json({error:"Invalid agent selection"},400)
    try {
      const inherited=await resolveStartupModel(body.model)
      if (!inherited) return json({error:"Choose an available model"},400)
      const profile=selectedAgent(body.name || undefined,root)
      const next=await agentSelection(profile,inherited)
      if (kindOf(next.model)!=="text") return json({error:"Choose a text model before selecting an agent"},400)
      return json({agent:profile?.name || "",model:next.provider.id + "/" + next.model.id})
    } catch(error) {return json({error:error instanceof Error ? error.message : "Agent unavailable"},400)}
  }

  if (url.pathname === "/api/mcp" && request.method === "GET") {
    const id = url.searchParams.get("sessionId") ?? ""
    const saved = /^[a-zA-Z0-9_-]+$/.test(id) ? await sessions.load(id).catch(() => undefined) : undefined
    return json({ servers: mcp.statuses(), config: configPath(), off: saved?.mcpOff ?? pendingMcpOff.get(id) ?? [] })
  }
  // /mcp off|on <server>: for this conversation only, saved with it.
  if (url.pathname === "/api/mcp/session" && request.method === "POST") {
    const body = (await request.json().catch(() => ({}))) as { sessionId?: unknown; server?: unknown; on?: unknown }
    if (typeof body.server !== "string" || !mcp.statuses().some((server) => server.name === body.server)) return json({ ok: false, message: "No MCP server called " + String(body.server) })
    const id = typeof body.sessionId === "string" && /^[a-zA-Z0-9_-]+$/.test(body.sessionId) ? body.sessionId : ""
    const saved = id ? await sessions.load(id).catch(() => undefined) : undefined
    const off = new Set(saved?.mcpOff ?? pendingMcpOff.get(id) ?? [])
    if (body.on === true) off.delete(body.server)
    else off.add(body.server)
    if (saved) { saved.mcpOff = [...off]; await sessions.save(saved) }
    else pendingMcpOff.set(id, [...off])
    return json({ ok: true, off: [...off] })
  }
  if (url.pathname === "/api/mcp/login") {
    if (request.method === "GET") return json({ state: mcpLogins.get(url.searchParams.get("id") || "")?.status() || "expired", servers: mcp.statuses() })
    if (request.method === "DELETE") {
      const id = url.searchParams.get("id") || ""
      mcpLogins.get(id)?.cancel()
      mcpLogins.delete(id)
      return json({ cancelled: true })
    }
    if (request.method === "POST") {
      if (mcpLogins.size + mcpLoginsStarting >= 2) return json({ message: "Close the previous MCP sign-in popup first" }, 409)
      mcpLoginsStarting++
      try {
        const body = await request.json() as { server?: unknown }
        if (typeof body.server !== "string" || body.server.length > 128) return json({ message: "Choose a configured MCP server" }, 400)
        const login = await mcp.login(body.server)
        const id = crypto.randomUUID()
        mcpLogins.set(id, login)
        setTimeout(() => { mcpLogins.delete(id); login.cancel() }, 5 * 60_000).unref()
        return json({ id, url: login.url })
      } catch (error) { return json({ message: error instanceof Error ? error.message : "MCP sign-in unavailable" }, 400) }
      finally { mcpLoginsStarting-- }
    }
  }

  // The project switcher, worktrees and branches. Each change is refused while
  // a turn is running, so no answer ever finds its folder moved under it.
  if (url.pathname === "/api/projects" && request.method === "GET") return json(projectInfo())
  if (url.pathname === "/api/project" && request.method === "POST") {
    const body = (await request.json().catch(() => ({}))) as { path?: unknown }
    // A refusal is an answer, not a failure: ok:false with words, so the page says it in place.
    if (typeof body.path !== "string" || !body.path.trim()) return json({ ok: false, message: "Choose a folder" })
    const problem = switchProject(body.path.trim())
    return problem ? json({ ok: false, message: problem }) : json({ ok: true, ...projectInfo() })
  }
  if (url.pathname === "/api/worktree" && request.method === "POST") {
    const body = (await request.json().catch(() => ({}))) as { action?: unknown; name?: unknown; path?: unknown }
    if (activeTurns.size) return json({ ok: false, message: "an answer is still running; try once it finishes" })
    try {
      if (body.action === "create" && typeof body.name === "string") {
        const made = createWorktree(root, body.name.trim())
        const problem = switchProject(made.path)
        return problem ? json({ ok: false, message: problem }) : json({ ok: true, message: `made worktree ${body.name.trim()} on ${made.branch} and opened it`, ...projectInfo() })
      }
      if (body.action === "remove" && typeof body.path === "string") {
        if (sameFolder(body.path, root)) return json({ ok: false, message: "open another project before removing this one" })
        removeWorktree(root, body.path)
        return json({ ok: true, message: "removed the worktree" + (process.platform === "win32" ? " (its folder is in the Recycle Bin)" : ""), ...projectInfo() })
      }
      return json({ ok: false, message: "Unknown worktree action" })
    } catch (error) {
      return json({ ok: false, message: error instanceof Error ? error.message : "worktree failed" })
    }
  }
  if (url.pathname === "/api/branch" && request.method === "POST") {
    const body = (await request.json().catch(() => ({}))) as { name?: unknown }
    if (activeTurns.size) return json({ ok: false, message: "an answer is still running; switch once it finishes" })
    if (typeof body.name !== "string") return json({ ok: false, message: "Choose a branch" })
    try {
      switchBranch(root, body.name)
      fileList = { files: [], at: 0 }
      return json({ ok: true, message: "switched to " + body.name, ...projectInfo() })
    } catch (error) {
      return json({ ok: false, message: error instanceof Error ? error.message : "switch failed" })
    }
  }

  if (url.pathname === "/api/sessions") {
    const all = await sessions.list(30, root)
    return json({ sessions: all.map(({ id, title, updated }) => ({ id, title, updated })) })
  }

  if (url.pathname === "/api/session" && request.method === "GET") {
    const session = await sessions.load(url.searchParams.get("id") ?? "")
    const resolved = session ? await resolveStartupModel(session.model ? session.provider + "/" + session.model : session.provider) : undefined
    const selected = resolved && kindOf(resolved.model) === "text" ? resolved : undefined
    if (session) session.activity = normaliseActivity(session.activity, true)
    // The page draws the recent end; the full record is one /export away.
    const shown = session ? sessions.displayWindow(session.messages) : undefined
    return session ? json({
      session: { ...session, messages: shown!.messages },
      hiddenMessages: shown!.hidden,
      archived: await sessions.hasArchive(session.id),
      selection: selected ? selected.provider.id + "/" + selected.model.id : undefined,
      context: selected ? usage(isLocalChat(selected.provider, selected.model.id) ? localChatMessages(session.messages) : session.messages, selected.model.contextWindow) : undefined,
      reviewNotice: editsFor(session.id, session.review).reviewNotice,
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
    const body = (await request.json()) as { theme?: unknown; thinking?: unknown; effort?: unknown; model?: string; appearance?: unknown; pasteSummary?: unknown; animations?: unknown; diffWrap?: unknown }
    const current = await settingsStore.load()
    if (body.effort !== undefined && (!settingsStore.isEffort(body.effort) || !exactSelection(body.model || ""))) return json({ message: "Select a valid model and effort level" }, 400)
    if (body.effort !== undefined) {
      // A level the model does not have is refused, never saved to be quietly ignored.
      const chosen = exactSelection(body.model || "")!
      const problem = effortProblem(chosen.model, chosen.provider.label + " " + chosen.model.label, String(body.effort))
      if (problem) return json({ message: problem }, 400)
    }
    const changed = {
      ...current,
      theme: body.theme ?? current.theme,
      thinking: body.thinking ?? current.thinking,
      appearance: body.appearance ?? current.appearance,
      pasteSummary: body.pasteSummary ?? current.pasteSummary,
      animations: body.animations ?? current.animations,
      diffWrap: body.diffWrap ?? current.diffWrap,
    }
    const next = body.effort !== undefined
      ? settingsStore.withModelEffort(settingsStore.normalise(changed), body.model!, body.effort)
      : settingsStore.normalise(changed)
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

  if (url.pathname === "/api/local/catalog" && request.method === "GET") {
    const active = currentDownload()
    return json({
      dir: ownedModelsDir(),
      active: active ? progressText(active) : undefined,
      catalog: LOCAL_CATALOG.map((entry) => ({ id: entry.id, label: entry.label, repo: entry.repo, size: gbOf(entry.bytes), about: entry.about, installed: isInstalled(entry) })),
    })
  }

  if (url.pathname === "/api/local/download" && request.method === "GET") {
    const active = currentDownload()
    return json({ active: active ? progressText(active) : undefined, last: lastDownload() })
  }

  // Starts and returns; the download runs in this server and the browser polls it.
  if (url.pathname === "/api/local/pull" && request.method === "POST") {
    const body = (await request.json().catch(() => ({}))) as { id?: unknown }
    const entry = LOCAL_CATALOG.find((item) => item.id === body.id)
    if (!entry) return json({ message: "Not a model CG-Next offers to download" }, 400)
    if (isInstalled(entry)) return json({ message: entry.label + " is already installed; pick it under Local models." })
    if (currentDownload()) return json({ message: "Already downloading " + currentDownload()!.entry.label + "; cancel it first." })
    downloadModel(entry).catch(() => {})
    return json({ started: true, message: "Downloading " + entry.label })
  }

  // /local runs against this server's own llama-server, which is the one the browser's prompts use.
  if (url.pathname === "/api/local" && request.method === "POST") {
    const body = (await request.json().catch(() => ({}))) as { argument?: unknown; model?: unknown }
    const argument = typeof body.argument === "string" ? body.argument.slice(0, 200) : ""
    const model = typeof body.model === "string" ? body.model.slice(0, 200) : undefined
    const response = json({ message: await localCommand(argument, model) })
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
      // A models.dev provider joins the picker as soon as it has a key.
      activateCatalog(auth.apiKey)
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
  // /open: a project file's text, for the person to read in the page. Inside
  // the project only, text only, and cut at 1 MB.
  if (url.pathname === "/api/view" && request.method === "GET") {
    const target = url.searchParams.get("path") ?? ""
    let absolute: string
    try { absolute = resolveInside(root, target) } catch { return json({ ok: false, message: "outside the project" }) }
    const handle = file(absolute)
    if (!(await handle.exists())) return json({ ok: false, message: "no such file: " + target })
    const bytes = new Uint8Array(await handle.slice(0, 1_000_000).arrayBuffer())
    if (bytes.includes(0)) return json({ ok: false, message: target + " is not a text file" })
    return json({ ok: true, path: target, text: new TextDecoder().decode(bytes), truncated: handle.size > 1_000_000 })
  }

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
    const id = body.sessionId ?? ""
    if (id && activeTurns.has(id)) return json({ message: "an answer is still running; undo once it finishes" }, 409)
    // After a restart the conversation's undo history comes back from its saved file.
    const saved = /^[a-zA-Z0-9_-]+$/.test(id) ? await sessions.load(id).catch(() => undefined) : undefined
    const edits = editsBySession.get(id) || (saved ? editsFor(id, saved.review) : undefined)
    const forward = body.direction === "redo"
    if (!edits) return json({ message: "nothing to undo - no file has been changed this session" })
    try {
      const checkpoint = forward ? await edits.redo(root) : await edits.undo(root)
      if (!checkpoint) return json({ message: nothingToDo(edits, forward) })
      // Saved straight away, so a restart does not undo the same turn twice.
      if (saved) await saveReviewSession(saved).catch(() => {})
      return json({ message: (forward ? "redid " : "undid ") + describeCheckpoint(checkpoint) })
    } catch (error) {
      return json({ message: "undo failed: " + (error instanceof Error ? error.message : "unknown") }, 500)
    }
  }

  if (url.pathname === "/api/diff" && request.method === "GET") {
    const id = url.searchParams.get("sessionId") ?? ""
    const saved = !editsBySession.has(id) && id ? await sessions.load(id) : undefined
    const edits = editsBySession.get(id) || (saved ? editsFor(id, saved.review) : undefined)
    if (!edits) return json({ files: [], added: 0, removed: 0, message: id ? "No edit history is available for this conversation in this server run." : "No conversation is selected." })
    const changes = await changesIn(root, edits)
    return json({ ...changes, message: [edits.reviewNotice, summarise(changes)].filter(Boolean).join(" ") })
  }

  if (url.pathname === "/api/stop" && request.method === "POST") {
    const body = (await request.json()) as { sessionId?: string }
    const id = body.sessionId ?? ""
    const active = activeTurns.get(id)
    if (active) {
      active.controller.abort()
      subagentsBySession.get(id)?.stopAll()
      // Unblock a turn waiting on consent, or it will hang forever.
      consent.abandon(id)
      // Wait for the aborted turn to commit its undo checkpoint and save the
      // session before releasing the lock or answering Stop.
      await Promise.race([active.done, Bun.sleep(2000)])
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

  // The answer to the model's question tool: labels picked, words typed, or null for dismissed.
  if (url.pathname === "/api/question" && request.method === "POST") {
    const body = (await request.json().catch(() => ({}))) as { id?: string; answer?: unknown }
    if (!consent.answerQuestion(body.id ?? "", body.answer)) return json({ ok: false, error: "no pending question" }, 404)
    return json({ ok: true })
  }

  // /fork: a saved copy of the conversation to carry on in; the original is not touched.
  if (url.pathname === "/api/session/fork" && request.method === "POST") {
    const body = (await request.json().catch(() => ({}))) as { id?: unknown }
    const id = typeof body.id === "string" ? body.id : ""
    if (id && activeTurns.has(id)) return json({ message: "An answer is still running; fork once it finishes" }, 409)
    const source = id ? await sessions.load(id).catch(() => undefined) : undefined
    if (!source || !source.messages.some((message) => message.role === "user")) return json({ message: "Nothing to fork yet - say something first" }, 400)
    const copy = await sessions.fork(source)
    return json({ id: copy.id, title: copy.title })
  }

  // /copy: the whole conversation as Markdown, stored keys scrubbed - the same text /export writes.
  if (url.pathname === "/api/session/transcript" && request.method === "POST") {
    const body = (await request.json().catch(() => ({}))) as { id?: unknown }
    const id = typeof body.id === "string" ? body.id : ""
    const source = id ? await sessions.load(id).catch(() => undefined) : undefined
    if (!source || !source.messages.some((message) => message.role === "user")) return json({ message: "Nothing to copy yet - say something first" }, 400)
    return json({ text: await sessionMarkdown(source, Date.now()) })
  }

  // `!command` from the composer: run as the person, kept in the conversation for the next prompt.
  if (url.pathname === "/api/shell" && request.method === "POST") {
    const body = (await request.json().catch(() => ({}))) as { text?: unknown; sessionId?: unknown; provider?: unknown }
    const command = typedCommand(typeof body.text === "string" ? body.text : "")
    if (!command) return json({ error: "Type ! and then a command" }, 400)
    const sessionId = typeof body.sessionId === "string" ? body.sessionId : ""
    if (sessionId && activeTurns.has(sessionId)) return json({ error: "An answer is still running in this conversation; the command waits for it" }, 409)
    const loaded = sessionId ? await sessions.load(sessionId) : undefined
    const selection = (typeof body.provider === "string" ? exactSelection(body.provider) : undefined)
      ?? (loaded ? exactSelection(loaded.provider + "/" + loaded.model) : undefined)
      ?? defaultSelection()
    const session = loaded ?? sessions.create(selection.provider.id, selection.model.id, root)
    if (session.messages.length === 0) session.messages.push({ role: "system", content: systemPrompt("browser") })
    // Only the deny rules matter here; nothing is asked about a command the person typed.
    const run = await runTypedCommand(command, root, Permissions.withConfig(async () => "reject"), request.signal)
    if (run.message) {
      session.messages.push(run.message)
      await saveReviewSession(session)
    }
    return json({ sessionId: session.id, display: run.message?.display ?? "! " + command + "\n\n" + run.output, refused: run.refused })
  }

  if (url.pathname === "/api/chat" && request.method === "POST") {
    const body = (await request.json()) as {
      text?: string
      sessionId?: string
      provider?: string
      agent?: string
      /** Pictures the page attached, already data URLs. */
      images?: { name?: string; dataUrl?: string }[]
      /** Ask for approval, Approve for me or Full access - ask when missing. */
      mode?: string
      planning?: boolean
      /** Subagents are offered only when the page asks for them with /boost. */
      boost?: boolean
      /** Long pastes the page folded to tokens; the text shown keeps the tokens. */
      pastes?: unknown
      /** Text files attached in the page: sent to the model as their contents. */
      files?: { name?: unknown; text?: unknown }[]
    }
    const text = (body.text ?? "").trim()
    if (!text) return json({ error: "empty prompt" }, 400)
    const requestedId = typeof body.sessionId === "string" ? body.sessionId.trim() : ""
    if (requestedId && activeTurns.has(requestedId)) {
      return json({ error: "An answer is still running in this conversation; wait for it to finish or stop it first." }, 409)
    }

    const turn = new AbortController()
    let finishTurn!: () => void
    const done = new Promise<void>((resolve) => { finishTurn = resolve })
    if (requestedId) activeTurns.set(requestedId, { controller: turn, done })
    let streamStarted = false
    /** The id the turn is held under once the session is known - a new conversation's own id. */
    let lockedId = requestedId
    try {
    const whole = sessions.unfoldPastes(text, body.pastes)

    const loaded = requestedId ? await sessions.load(requestedId) : undefined
    if (body.agent !== undefined && (typeof body.agent !== "string" || body.agent.length > 128)) return json({error:"Invalid agent profile"},400)
    let profile: ReturnType<typeof selectedAgent>
    let selection
    try {
      profile=selectedAgent(body.agent===undefined ? loaded?.agent : body.agent || undefined,root)
      const inherited=body.provider ? await resolveStartupModel(body.provider) : defaultSelection()
      selection=inherited ? await agentSelection(profile,inherited) : undefined
    } catch(error) {return json({error:error instanceof Error ? error.message : "Agent unavailable"},400)}
    if (!selection || kindOf(selection.model) !== "text") return json({ error: "Requested chat model is unavailable; choose a model before continuing." }, 400)
    const { provider, model } = selection
    const key = apiKey(provider.id)
    if (key === undefined) return json({ error: `No API key for ${provider.label}.` }, 400)

    const session =
      loaded ?? sessions.create(provider.id, model.id, root)
    if (requestedId && requestedId !== session.id && activeTurns.get(requestedId)?.controller === turn) {
      activeTurns.delete(requestedId)
    }
    if (activeTurns.has(session.id) && activeTurns.get(session.id)?.controller !== turn) {
      return json({ error: "An answer is still running in this conversation; wait for it to finish or stop it first." }, 409)
    }
    activeTurns.set(session.id, { controller: turn, done })
    lockedId = session.id
    // Switched off before the conversation had been saved: carried into it now.
    if (!loaded && pendingMcpOff.has("")) { session.mcpOff = pendingMcpOff.get(""); pendingMcpOff.delete("") }
    session.provider = provider.id
    session.model = model.id
    session.agent = profile?.name

    if (session.messages.length === 0) {
      session.messages.push({
        role: "system",
        content: systemPrompt("browser"),
      })
    }
    // Mentions are read here, so the stored message carries its files and a
    // resumed conversation still has the context it was answered with.
    // A custom command or a skill is sent as its text; the line typed is what is shown.
    const invoked = whole.startsWith("/") ? resolveInvocation(whole, root) : undefined
    // "@explore <task>" hands the task to that agent, with subagents on for this message.
    const delegated = invoked ? undefined : agentMention(whole, root)
    if (delegated) body.boost = true
    const mentioned = await expandMentions(invoked ? invoked.content : delegated ? delegated.content : whole, root)

    // Pictures arrive two ways and mean the same thing once they are here:
    // attached in the page, or @mentioned by path like any other file.
    const pasted = (body.images ?? [])
      .filter((image) => typeof image?.dataUrl === "string" && image.dataUrl.startsWith("data:image/"))
      .slice(0, 10)
      .map((image) => ({ name: String(image.name ?? "image"), dataUrl: String(image.dataUrl) }))
    const images = [...pasted, ...mentioned.images]
    // Attached text files go to the model as their contents, after what was typed.
    let budget = 2_000_000
    const attachedFiles = (Array.isArray(body.files) ? body.files : []).slice(0, 10).flatMap((entry) => {
      const name = typeof entry?.name === "string" ? entry.name.replace(/[\r\n`]/g, "").slice(0, 120) : ""
      const content = typeof entry?.text === "string" ? entry.text : undefined
      if (!name || content === undefined || content.includes("\u0000") || content.length > 512_000 || content.length > budget) return []
      budget -= content.length
      return [{ name, content }]
    })
    if (attachedFiles.length) {
      const fence = "````"
      mentioned.content += attachedFiles.map((file) => `\n\nAttached file ${file.name}:\n${fence}\n${file.content}\n${fence}`).join("")
    }

    session.messages.push(
      mentioned.files.length || images.length || invoked || delegated || attachedFiles.length || whole !== text
        ? { role: "user", content: mentioned.content, display: text, images, at: Date.now() }
        : { role: "user", content: text, at: Date.now() },
    )
    // Everything after it is this turn's; stamped when the turn is saved, for /timestamps.
    const turnFrom = session.messages.length

    // Server-sent events: the browser gets the same event stream the TUI sees.
    const stream = new ReadableStream({
      async start(controller) {
        const encoder = new TextEncoder()
        const send = (event: unknown) => {
          try {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}

`))
          } catch {}
        }

        const encoderPing = new TextEncoder()
        const heartbeat = setInterval(() => {
          try {
            controller.enqueue(encoderPing.encode(": keepalive" + String.fromCharCode(10, 10)))
          } catch {
            clearInterval(heartbeat)
          }
        }, 5000)

        send({ type: "session", id: session.id, model:provider.id + "/" + model.id, agent:profile?.name || "" })
        // One checkpoint per turn, so undo takes back the whole answer.
        const edits = editsFor(session.id, session.review)
        session.activity = normaliseActivity(session.activity, true)
        edits.begin(text)
        // Say what was attached: a mention that silently did nothing and a
        // mention that worked would otherwise look exactly the same.
        if (mentioned.files.length) send({ type: "attached", files: mentioned.files })
        const permissions = withMode(consent.forSession(session.id, send), body)
        const askUser = consent.askerFor(session.id, send)
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
          mcp: withoutServers(mcp, session.mcpOff ?? []),
          instructions: [skillIndex(listSkills(root)), withoutServers(mcp, session.mcpOff ?? []).notice()].filter(Boolean).join(String.fromCharCode(10, 10)) || undefined,
          effort: effortFor(model, settingsStore.effortForModel(await settingsStore.load(), provider.id + "/" + model.id)),
        })
        let subagents = subagentsBySession.get(session.id)
        if (!subagents) {
          const id = session.id
          subagents = new SubagentManager(() => subagentContexts.get(id)!)
          subagentsBySession.set(id, subagents)
        }
        subagents.onEvent = (event) => {
          recordActivity(session.activity!, event)
          send(
            event.type === "subagent_event" && event.event.type === "tool_denied"
              ? { ...event, event: { ...event.event, label: refusalLabel(event.event) } }
              : event,
          )
        }
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
            subagents: !profile?.tools && (body.boost === true || subagents.running().length) ? subagents : undefined,
            tools: profile?.tools,
            extraTools: withoutServers(mcp, session.mcpOff ?? []),
            askUser,
            memory: await memory.recall({ project: root, session: session.id }),
            // Servers that are configured but down are named, so the model says so
            // rather than reaching for an unrelated tool in their place.
            instructions: [profile ? "Active agent: " + profile.name + "\n" + profile.prompt : undefined, skillIndex(listSkills(root)), withoutServers(mcp, session.mcpOff ?? []).notice()].filter(Boolean).join(String.fromCharCode(10, 10)) || undefined,
            history: edits,
            // Compaction archives what it replaces, so /export still has every word.
            archive: sessions.appendArchive.bind(null, session.id),
            effort: effortFor(model, settingsStore.effortForModel(await settingsStore.load(), provider.id + "/" + model.id)),
            signal: turn.signal,
          })) {
            recordActivity(session.activity!, event)
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
              context: usage(isLocalChat(provider, model.id) ? localChatMessages(session.messages) : session.messages, model.contextWindow),
            })
          }
          // Committed before saving, so the turn's undo checkpoint is saved with it.
          edits.commit(root)
          sessions.stampNew(session.messages, turnFrom)
          await saveReviewSession(session)
          if (session.messages.at(-1)?.stopped) send({ type: "stopped" })
          send({ type: "saved", id: session.id, title: session.title })
        } catch (error) {
          // Stopping mid-stream throws out of the loop. The TUI keeps the
          // conversation when that happens; here it used to vanish - the
          // prompt never reached Sessions and could not be resumed. A stop
          // is also not an error worth reporting. A provider failure is saved
          // too: an approved write may already be on disk, and losing the
          // conversation would lose the only record of it and its diff.
          if (turn.signal.aborted && !session.messages.at(-1)?.stopped) session.messages.push({ role: "assistant", content: "", stopped: true })
          edits.commit(root)
          await saveReviewSession(session).catch(() => {})
          if (turn.signal.aborted) send({ type: "stopped" })
          else send({ type: "error", message: error instanceof Error ? error.message : "request failed" })
        } finally {
          edits.commit(root)
          clearInterval(heartbeat)
          if (activeTurns.get(session.id)?.controller === turn) activeTurns.delete(session.id)
          finishTurn()
          try { controller.close() } catch {}
        }
      },
    })

    streamStarted = true
    return new Response(stream, {
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" },
    })
    } finally {
      if (!streamStarted) {
        // Anything that ended this request before the stream - a refusal or a throw - lets the conversation go.
        for (const id of new Set([requestedId, lockedId])) if (id && activeTurns.get(id)?.controller === turn) activeTurns.delete(id)
        finishTurn()
      }
    }
  }

  if (url.pathname === "/logo.png") {
    return new Response(file(fileURLToPath(new URL("./logo.png", import.meta.url))), {
      headers: { "content-type": "image/png", "cache-control": "max-age=86400" },
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
    server = Bun.serve<TerminalSocket["data"]>({
      port,
      hostname: "127.0.0.1",
      idleTimeout: 255,
      fetch: handle as (request: Request, server: Bun.Server<TerminalSocket["data"]>) => Promise<Response>,
      websocket: {
        open(socket) {
          const size = socket.data as TerminalSocket["data"] & { cols?: number; rows?: number }
          startTerminal(socket as unknown as TerminalSocket, size.cols, size.rows)
        },
        message(socket, message) { terminalMessage(socket as unknown as TerminalSocket, message as string) },
        close(socket) { endTerminal(socket as unknown as TerminalSocket) },
      },
    })
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
