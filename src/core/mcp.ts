import { loadConfig, type McpServer } from "./config"
import { clip } from "./tools"
import { McpAuthorizationRequired, mcpAccessToken, discoverMcpOAuth, beginMcpOAuth, type McpOAuthConfig, type McpOAuthLogin } from "./mcp-oauth"
import type { Network } from "./webfetch"

/**
 * An MCP client, written here rather than taken from the official SDK.
 *
 * The SDK would have been 17 direct dependencies and about 14 MB, most of it
 * server code a client never runs. What a client needs is small: JSON-RPC over
 * a child process's stdin and stdout, or over Streamable HTTP; the initialize
 * handshake; listing tools; calling them.
 *
 * Servers come from the global codegoblin.jsonc only, never from the project,
 * so opening a repository can never start a command that repository declares.
 *
 * Not built yet: the older HTTP+SSE transport, the
 * standing GET stream a server can use to push notifications between requests,
 * and resources and prompts.
 */

export const LATEST_PROTOCOL_VERSION = "2025-11-25"
export const SUPPORTED_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05", "2024-10-07"]
export const DEFAULT_TIMEOUT = 30_000
const CLIENT_INFO = { name: "codegoblin", version: "0.0.0" }

/** Chat-completions tool names must match this, and some providers stop at 64 characters. */
const MAX_NAME = 64

export type JsonRpcId = number | string
export type RpcMessage = {
  jsonrpc: "2.0"
  id?: JsonRpcId | null
  method?: string
  params?: unknown
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

export type TransportHandlers = {
  message: (message: RpcMessage) => void
  /** The connection is gone for good, and why. */
  close: (reason: string) => void
}

export interface Transport {
  start(handlers: TransportHandlers): Promise<void>
  send(message: RpcMessage): Promise<void>
  /** HTTP carries the negotiated version on every request after initialize. */
  setProtocolVersion?(version: string): void
  close(): Promise<void>
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const describeError = (error: unknown) => (error instanceof Error ? error.message : String(error))

const formatDuration = (ms: number) => (ms < 1000 ? ms + "ms" : ms / 1000 + "s")

/**
 * The command as Bun can start it.
 *
 * Bun refuses to start a .cmd or .bat shim directly (EINVAL) but finds the very
 * same shim from its bare name, so `npx.cmd` is started as `npx`. A shim given
 * with a directory is left alone - there is no bare name to fall back to.
 */
export function launchable(command: string[], platform: string = process.platform): string[] {
  const [program, ...rest] = command
  if (platform !== "win32" || !program) return command
  if (/^[^\\/]+\.(cmd|bat)$/i.test(program)) return [program.replace(/\.(cmd|bat)$/i, ""), ...rest]
  return command
}

/** A server started as a child process, speaking one JSON message per line. */
export class StdioTransport implements Transport {
  private child?: Bun.Subprocess<"pipe", "pipe", "pipe">
  private closing = false
  private stderrTail = ""

  constructor(
    private command: string[],
    private environment: Record<string, string> = {},
  ) {}

  async start(handlers: TransportHandlers): Promise<void> {
    const program = this.command[0] ?? ""
    let child: Bun.Subprocess<"pipe", "pipe", "pipe">
    try {
      child = Bun.spawn({
        cmd: launchable(this.command),
        env: { ...process.env, ...this.environment },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        windowsHide: true,
      })
    } catch (error) {
      throw new Error(`could not start ${program}: ${describeError(error)}`)
    }
    this.child = child

    void (async () => {
      const reader = child.stdout.getReader()
      const decoder = new TextDecoder()
      let buffer = ""
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let at: number
        while ((at = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, at).trim()
          buffer = buffer.slice(at + 1)
          if (!line) continue
          let parsed: unknown
          try {
            parsed = JSON.parse(line)
          } catch {
            // Servers are not supposed to print anything else on stdout, but
            // some do; a stray log line must not end the connection.
            continue
          }
          if (isRecord(parsed)) handlers.message(parsed as RpcMessage)
        }
      }
    })().catch(() => {})

    // Stderr is where servers log. It is drained so a chatty server cannot
    // fill the pipe and stall, and its tail is kept to explain a crash.
    const stderrDone = (async () => {
      const reader = child.stderr.getReader()
      const decoder = new TextDecoder()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        this.stderrTail = (this.stderrTail + decoder.decode(value, { stream: true })).slice(-2000)
      }
    })().catch(() => {})

    void Promise.all([child.exited, stderrDone]).then(([code]) => {
      if (this.closing) return
      const tail = this.stderrTail.trim().split("\n").slice(-5).join(" | ")
      handlers.close(`${program} exited with code ${code}${tail ? ": " + tail : ""}`)
    })
  }

  async send(message: RpcMessage): Promise<void> {
    if (!this.child) throw new Error("not started")
    this.child.stdin.write(JSON.stringify(message) + "\n")
    await this.child.stdin.flush()
  }

  async close(): Promise<void> {
    const child = this.child
    if (!child || this.closing) return
    this.closing = true
    try {
      await child.stdin.end()
    } catch {
      // Already gone.
    }
    const exited = await Promise.race([child.exited.then(() => true), new Promise<boolean>((done) => setTimeout(() => done(false), 1000))])
    if (exited) return
    // npx and friends start the real server as a grandchild, which killing the
    // wrapper alone leaves running on Windows.
    if (process.platform === "win32") {
      Bun.spawnSync({ cmd: ["taskkill", "/T", "/F", "/PID", String(child.pid)], stdout: "ignore", stderr: "ignore" })
    } else {
      child.kill()
    }
  }
}

/**
 * Server-sent events, fed in whatever chunks the network delivers.
 *
 * Returns the data of each complete event. Line endings are normalised first,
 * so a CRLF split across two chunks is still one line ending.
 */
export class SseParser {
  private buffer = ""

  push(chunk: string): string[] {
    this.buffer = (this.buffer + chunk).split("\r\n").join("\n")
    const events: string[] = []
    let at: number
    while ((at = this.buffer.indexOf("\n\n")) !== -1) {
      const block = this.buffer.slice(0, at)
      this.buffer = this.buffer.slice(at + 2)
      const data = block
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).replace(/^ /, ""))
      if (data.length) events.push(data.join("\n"))
    }
    return events
  }
}

/** A remote server over Streamable HTTP: every message is a POST, answered with JSON or an event stream. */
export class HttpTransport implements Transport {
  private session?: string
  private version?: string
  private handlers?: TransportHandlers
  private abort = new AbortController()

  constructor(
    private url: string,
    private headers: Record<string, string> = {},
    private oauth?: McpOAuthConfig,
    private oauthNetwork?: Network,
  ) {}

  async start(handlers: TransportHandlers): Promise<void> {
    this.handlers = handlers
  }

  setProtocolVersion(version: string) {
    this.version = version
  }

  private sessionHeaders(): Record<string, string> {
    return {
      ...(this.session ? { "mcp-session-id": this.session } : {}),
      ...(this.version ? { "mcp-protocol-version": this.version } : {}),
    }
  }

  private async authHeaders() {
    if (this.oauth === false || Object.keys(this.headers).some(key => key.toLowerCase() === "authorization")) return this.headers
    const token = await mcpAccessToken(this.url, this.oauthNetwork)
    return { ...this.headers, ...(token ? { authorization: "Bearer " + token } : {}) }
  }

  async send(message: RpcMessage): Promise<void> {
    const response = await (this.oauthNetwork?.fetch ?? fetch)(new URL(this.url), {
      method: "POST",
      redirect: "manual",
      signal: this.abort.signal,
      headers: {
        ...await this.authHeaders(),
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...this.sessionHeaders(),
      },
      body: JSON.stringify(message),
    })

    const session = response.headers.get("mcp-session-id")
    if (session) this.session = session

    if (response.status === 202) {
      await response.body?.cancel().catch(() => {})
      return
    }
    if (!response.ok) {
      if ((response.status === 401 || (response.status === 403 && /error="insufficient_scope"/i.test(response.headers.get("www-authenticate") || ""))) && this.oauth !== false && !Object.keys(this.headers).some(key => key.toLowerCase() === "authorization")) {
        const challenge = response.headers.get("www-authenticate") || ""
        await response.body?.cancel().catch(() => {})
        throw new McpAuthorizationRequired(challenge.slice(0, 4096))
      }
      const text = (await response.text().catch(() => "")).trim()
      if (response.status === 404 && this.session) {
        throw new Error("the server no longer knows this session (HTTP 404)")
      }
      throw new Error(`HTTP ${response.status}${text ? ": " + text.slice(0, 300) : ""}`)
    }

    const type = response.headers.get("content-type") ?? ""
    if (type.includes("text/event-stream") && response.body) {
      // Read in the background: the answer is matched to its request by id, and
      // a stream may carry notifications before it.
      void this.read(response.body)
      return
    }
    if (type.includes("application/json")) {
      const body: unknown = await response.json()
      for (const each of Array.isArray(body) ? body : [body]) {
        if (isRecord(each)) this.handlers?.message(each as RpcMessage)
      }
      return
    }
    await response.body?.cancel().catch(() => {})
  }

  private async read(body: ReadableStream<Uint8Array>) {
    const reader = body.getReader()
    const decoder = new TextDecoder()
    const parser = new SseParser()
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        for (const data of parser.push(decoder.decode(value, { stream: true }))) {
          try {
            const parsed: unknown = JSON.parse(data)
            if (isRecord(parsed)) this.handlers?.message(parsed as RpcMessage)
          } catch {
            // Not a message; a keepalive or a comment.
          }
        }
      }
    } catch {
      // A dropped stream leaves its request to time out, which names it.
    }
  }

  async close(): Promise<void> {
    this.abort.abort()
    if (!this.session) return
    const headers = { ...await this.authHeaders().catch(() => this.headers), ...this.sessionHeaders() }
    this.session = undefined
    await (this.oauthNetwork?.fetch ?? fetch)(new URL(this.url), { method: "DELETE", headers, redirect: "manual", signal: AbortSignal.timeout(5000) }).catch(() => {})
  }
}

export function transportFor(config: McpServer): Transport {
  return config.type === "local"
    ? new StdioTransport(config.command, config.environment)
    : new HttpTransport(config.url, config.headers, config.oauth)
}

/**
 * A tool result as the text the model is given.
 *
 * Tool results reach the model as text on this wire, so a picture is described
 * rather than silently dropped. An error keeps the "error:" prefix the built-in
 * tools use, so both surfaces mark it failed.
 */
export function formatToolResult(result: unknown): string {
  if (!isRecord(result)) return "error: the server returned no result"
  const parts: string[] = []
  for (const item of Array.isArray(result.content) ? result.content : []) {
    if (!isRecord(item)) continue
    if (item.type === "text" && typeof item.text === "string") {
      parts.push(item.text)
    } else if (item.type === "image" || item.type === "audio") {
      const size = typeof item.data === "string" ? Math.round((item.data.length * 3) / 4 / 1024) + " KB" : "unknown size"
      parts.push(`[${item.type} ${String(item.mimeType ?? "")} (${size}) - not shown, tool results reach the model as text]`)
    } else if (item.type === "resource_link") {
      parts.push(`[resource link: ${String(item.name ?? "")} ${String(item.uri ?? "")}]`)
    } else if (item.type === "resource" && isRecord(item.resource)) {
      const resource = item.resource
      parts.push(typeof resource.text === "string" ? resource.text : `[resource: ${String(resource.uri ?? "?")}]`)
    }
  }
  if (!parts.length && result.structuredContent !== undefined) {
    parts.push(JSON.stringify(result.structuredContent, null, 2))
  }
  const text = parts.join("\n\n") || "(the tool returned nothing)"
  return clip(result.isError === true ? "error: " + text : text)
}

/** FNV-1a, as eight hex digits. Only ever used to tell names apart. */
function shortHash(text: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, "0")
}

/**
 * The name a tool is offered to the model under.
 *
 * `mcp__server__tool`, because the chat-completions wire only takes letters,
 * digits, underscores and hyphens - DeepSeek answers 400 to the fork's
 * `server:tool`. When a name had to be changed or cut to fit, a hash of the
 * real names goes on the end, so two tools can never end up sharing one.
 */
export function toolNameFor(server: string, tool: string): string {
  const safe = (text: string) => text.replace(/[^a-zA-Z0-9_-]/g, "_")
  const name = `mcp__${safe(server)}__${safe(tool)}`
  if (name.length <= MAX_NAME && name === `mcp__${server}__${tool}`) return name
  const tag = "_" + shortHash(JSON.stringify([server, tool]))
  return name.length + tag.length <= MAX_NAME ? name + tag : name.slice(0, MAX_NAME - tag.length) + tag
}

export type McpToolInfo = { name: string; description?: string; inputSchema?: Record<string, unknown> }
export type ClientStatus = "disabled" | "connecting" | "connected" | "authorization_required" | "failed" | "closed"

type Waiting = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }

/** One configured server: the handshake, its tools, and calls to them. */
export class McpClient {
  status: ClientStatus
  error?: string
  authChallenge = ""
  tools: McpToolInfo[] = []
  protocolVersion?: string
  serverInfo?: { name?: string; version?: string }
  instructions?: string
  /** Called when the server says its tools changed and the new list is in. */
  onToolsChanged?: () => void

  private transport?: Transport
  private nextId = 1
  private waiting = new Map<JsonRpcId, Waiting>()

  constructor(
    readonly name: string,
    readonly config: McpServer,
    private makeTransport: (config: McpServer) => Transport = transportFor,
  ) {
    this.status = config.enabled ? "connecting" : "disabled"
  }

  get timeout(): number {
    return this.config.timeout ?? DEFAULT_TIMEOUT
  }

  async connect(): Promise<void> {
    if (!this.config.enabled) return
    this.status = "connecting"
    this.error = undefined
    try {
      const transport = this.makeTransport(this.config)
      this.transport = transport
      await transport.start({ message: (message) => this.receive(message), close: (reason) => this.lost(reason) })

      const result = await this.request("initialize", {
        protocolVersion: LATEST_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: CLIENT_INFO,
      })
      if (!isRecord(result)) throw new Error("the server answered initialize with nothing")
      const version = String(result.protocolVersion ?? "")
      if (!SUPPORTED_PROTOCOL_VERSIONS.includes(version)) {
        throw new Error(`the server speaks MCP protocol "${version}", which this client does not`)
      }
      this.protocolVersion = version
      transport.setProtocolVersion?.(version)
      if (isRecord(result.serverInfo)) {
        this.serverInfo = { name: String(result.serverInfo.name ?? ""), version: String(result.serverInfo.version ?? "") }
      }
      if (typeof result.instructions === "string") this.instructions = result.instructions

      await transport.send({ jsonrpc: "2.0", method: "notifications/initialized" })
      const offersTools = isRecord(result.capabilities) && result.capabilities.tools !== undefined
      this.tools = offersTools ? await this.listTools() : []
      this.status = "connected"
    } catch (error) {
      this.status = error instanceof McpAuthorizationRequired ? "authorization_required" : "failed"
      if (error instanceof McpAuthorizationRequired) this.authChallenge = error.challenge
      this.error ??= describeError(error)
      await this.shutdown()
    }
  }

  private receive(message: RpcMessage) {
    const hasId = message.id !== undefined && message.id !== null
    if (hasId && !message.method) {
      const waiting = this.waiting.get(message.id!)
      if (!waiting) return
      clearTimeout(waiting.timer)
      this.waiting.delete(message.id!)
      if (message.error) waiting.reject(new Error(`${message.error.message} (code ${message.error.code})`))
      else waiting.resolve(message.result)
      return
    }
    if (hasId && message.method) {
      // The server asking the client something. This client offers nothing to
      // ask for, but a question left unanswered can stall a server.
      const answer: RpcMessage =
        message.method === "ping"
          ? { jsonrpc: "2.0", id: message.id, result: {} }
          : { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `${message.method} is not supported by this client` } }
      void this.transport?.send(answer).catch(() => {})
      return
    }
    if (message.method === "notifications/tools/list_changed" && this.status === "connected") {
      void this.listTools()
        .then((tools) => {
          this.tools = tools
          this.onToolsChanged?.()
        })
        .catch((error) => {
          this.error = "could not re-list tools: " + describeError(error)
        })
    }
  }

  /** The connection went away underneath us. */
  private lost(reason: string) {
    for (const [id, waiting] of this.waiting) {
      clearTimeout(waiting.timer)
      waiting.reject(new Error(`${this.name} closed: ${reason}`))
      this.waiting.delete(id)
    }
    if (this.status === "connected" || this.status === "connecting") {
      // A server that was working and then went away can be started again; one
      // that never connected - a wrong command - would only fail the same way.
      if (this.status === "connected") this.dropped = true
      this.status = "failed"
      this.error = reason
      this.onToolsChanged?.()
    }
  }

  /** Whether this server was working and then went away underneath us. */
  dropped = false
  restarts = 0

  /** Starts a dropped server again, from scratch. */
  async restart(): Promise<void> {
    this.dropped = false
    this.restarts++
    await this.shutdown()
    await this.connect()
  }

  request(method: string, params?: unknown, timeout: number = this.timeout): Promise<unknown> {
    const transport = this.transport
    if (!transport) return Promise.reject(new Error("not connected"))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.waiting.delete(id)) return
        reject(new Error(`${this.name} did not answer ${method} within ${formatDuration(timeout)}`))
        // Initialize is never cancelled; anything else is, so the server can stop working on it.
        if (method !== "initialize") {
          void transport
            .send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id, reason: "timed out" } })
            .catch(() => {})
        }
      }, timeout)
      this.waiting.set(id, { resolve, reject, timer })
      transport.send({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) }).catch((error) => {
        if (!this.waiting.delete(id)) return
        clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(String(error)))
      })
    })
  }

  private async listTools(): Promise<McpToolInfo[]> {
    const tools: McpToolInfo[] = []
    let cursor: string | undefined
    let pages = 0
    do {
      const page = await this.request("tools/list", cursor ? { cursor } : {})
      const listed = isRecord(page) && Array.isArray(page.tools) ? page.tools : []
      for (const tool of listed) {
        if (!isRecord(tool) || typeof tool.name !== "string" || !tool.name) continue
        tools.push({
          name: tool.name,
          ...(typeof tool.description === "string" ? { description: tool.description } : {}),
          ...(isRecord(tool.inputSchema) ? { inputSchema: tool.inputSchema } : {}),
        })
      }
      cursor = isRecord(page) && typeof page.nextCursor === "string" && page.nextCursor ? page.nextCursor : undefined
    } while (cursor && ++pages < 100)
    return tools
  }

  /** A tool call, answered as text. Failures come back as text too, never as a throw. */
  async callTool(tool: string, args: unknown): Promise<string> {
    if (this.status !== "connected") {
      return `error: the ${this.name} MCP server is ${this.status}${this.error ? " - " + this.error : ""}`
    }
    try {
      const result = await this.request("tools/call", { name: tool, arguments: isRecord(args) ? args : {} })
      return formatToolResult(result)
    } catch (error) {
      if (error instanceof McpAuthorizationRequired) {
        this.status = "authorization_required"
        this.authChallenge = error.challenge
        this.error = error.message
        this.tools = []
        this.onToolsChanged?.()
      }
      return "error: " + describeError(error)
    }
  }

  private async shutdown() {
    const transport = this.transport
    this.transport = undefined
    for (const [id, waiting] of this.waiting) {
      clearTimeout(waiting.timer)
      waiting.reject(new Error(`${this.name} was closed`))
      this.waiting.delete(id)
    }
    await transport?.close().catch(() => {})
  }

  async close(): Promise<void> {
    if (this.status !== "disabled") this.status = "closed"
    await this.shutdown()
  }
}

export type McpToolEntry = { name: string; server: string; tool: McpToolInfo; client: McpClient }

/** How many times a server that dropped out is started again in one session. */
const MAX_RESTARTS = 3

export type McpServerStatus = {
  name: string
  type: "local" | "remote"
  status: ClientStatus
  tools: string[]
  error?: string
  /** The command or URL, so a person can tell which entry in the config this is. */
  target: string
  oauth?: boolean
}

/**
 * Every configured server, and their tools as one list for the agent.
 *
 * One server failing - a typo in its command, a remote that is down - leaves
 * the others working; it is reported by /mcp rather than stopping anything.
 */
/**
 * The servers one conversation has switched off, as the fork's per-session
 * MCP toggle: their tools are not offered to the model in this conversation,
 * and nothing about the server or codegoblin.jsonc changes.
 */
export function withoutServers(manager: McpManager, off: Iterable<string>): McpManager {
  const hidden = new Set(off)
  if (!hidden.size) return manager
  const shown = () => manager.entries().filter((entry) => !hidden.has(entry.server))
  return Object.assign(Object.create(manager) as McpManager, {
    entries: shown,
    schema: () => manager.schema().filter((tool) => shown().some((entry) => entry.name === tool.function.name)),
    has: (name: string) => shown().some((entry) => entry.name === name),
    call: (name: string, args: unknown) => (shown().some((entry) => entry.name === name) ? manager.call(name, args) : Promise.resolve(`error: the ${name.split("__")[1] ?? ""} MCP server is switched off in this conversation - /mcp turns it back on`)),
    notice: () => {
      const base = manager.notice()
      const named = manager.clients.filter((client) => hidden.has(client.name)).map((client) => client.name)
      const off = named.length ? `The user switched these MCP servers off for this conversation: ${named.join(", ")}. Do not use them or anything in their place unless asked.` : ""
      return [base, off].filter(Boolean).join("\n") || undefined
    },
  })
}

export class McpManager {
  readonly clients: McpClient[]
  /** Called when a server finishes connecting, fails, or changes its tools. */
  onChange?: () => void
  private started?: Promise<void>
  private logins = new Map<string, McpOAuthLogin>()
  private loginStarting = new Set<string>()
  private closing = false

  constructor(servers: Record<string, McpServer>, makeTransport: (config: McpServer) => Transport = transportFor) {
    this.clients = Object.entries(servers).map(([name, config]) => {
      const client = new McpClient(name, config, makeTransport)
      client.onToolsChanged = () => this.onChange?.()
      return client
    })
  }

  static fromConfig(): McpManager {
    return new McpManager(loadConfig().mcp)
  }

  /** Connects every enabled server at once. Never throws; a failure is a status. */
  start(): Promise<void> {
    this.started ??= Promise.all(
      this.clients.map(async (client) => {
        await client.connect()
        this.onChange?.()
      }),
    ).then(() => {})
    return this.started
  }

  /** Waits for the servers, but never longer than `limit` - a slow server must not hold up a message. */
  async settled(limit: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([this.start().then(() => this.revive()), new Promise<void>((done) => (timer = setTimeout(done, limit)))])
    clearTimeout(timer)
  }

  /**
   * Starts again any server that dropped out mid-session, a few times at most.
   * Killed mid-session, the fixture server simply vanished: its tools were gone,
   * nothing brought it back, and the model reached for an unrelated tool instead.
   */
  async revive(): Promise<void> {
    const dropped = this.clients.filter((client) => client.dropped && client.restarts < MAX_RESTARTS)
    await Promise.all(
      dropped.map(async (client) => {
        await client.restart()
        this.onChange?.()
      }),
    )
  }

  /**
   * What the model is told about servers that are configured but not working,
   * so it says so rather than using some other tool in their place.
   */
  notice(): string | undefined {
    const down = this.clients.filter((client) => client.status === "failed" || client.status === "closed" || client.status === "authorization_required")
    if (!down.length) return undefined
    return [
      "These MCP servers are configured but not running, so their tools are not available:",
      ...down.map((client) => `- ${client.name}: ${client.status}${client.error ? " - " + client.error.slice(0, 200) : ""}`),
      "If the user asks for one of them, say it is not running and why. Do not use a different tool in its place.",
    ].join("\n")
  }

  entries(): McpToolEntry[] {
    const seen = new Set<string>()
    const entries: McpToolEntry[] = []
    for (const client of this.clients) {
      if (client.status !== "connected") continue
      for (const tool of client.tools) {
        const name = toolNameFor(client.name, tool.name)
        if (seen.has(name)) continue
        seen.add(name)
        entries.push({ name, server: client.name, tool, client })
      }
    }
    return entries
  }

  /** The tools in the shape the chat-completions request takes. */
  schema(): { type: "function"; function: { name: string; description: string; parameters: Record<string, unknown> } }[] {
    return this.entries().map((entry) => ({
      type: "function" as const,
      function: {
        name: entry.name,
        description: `From the ${entry.server} MCP server. ${entry.tool.description ?? ""}`.trim(),
        parameters: entry.tool.inputSchema ?? { type: "object", properties: {} },
      },
    }))
  }

  /** Servers still connecting, by name. */
  connecting(): string[] {
    return this.clients.filter((client) => client.status === "connecting").map((client) => client.name)
  }

  has(name: string): boolean {
    return this.entries().some((entry) => entry.name === name)
  }

  async call(name: string, args: unknown): Promise<string> {
    const entry = this.entries().find((each) => each.name === name)
    if (!entry) return `unknown tool: ${name}`
    return entry.client.callTool(entry.tool.name, args)
  }

  statuses(): McpServerStatus[] {
    return this.clients.map((client) => ({
      name: client.name,
      type: client.config.type,
      status: client.status,
      tools: client.status === "connected" ? client.tools.map((tool) => tool.name) : [],
      ...(client.error ? { error: client.error } : {}),
      target: client.config.type === "local" ? client.config.command.join(" ") : client.config.url,
      oauth: client.config.type === "remote" && client.config.enabled && client.config.oauth !== false && !Object.keys(client.config.headers).some(key => key.toLowerCase() === "authorization"),
    }))
  }

  async close(): Promise<void> {
    this.closing = true
    for (const login of this.logins.values()) login.cancel()
    await Promise.all(this.clients.map((client) => client.close()))
  }

  async login(name: string): Promise<McpOAuthLogin> {
    if (this.closing || this.loginStarting.has(name)) throw new Error("Finish the current sign-in attempt first")
    const client = this.clients.find(client => client.name === name)
    if (!client || client.config.type !== "remote" || !client.config.enabled || client.config.oauth === false || Object.keys(client.config.headers).some(key => key.toLowerCase() === "authorization")) throw new Error("Choose an enabled OAuth remote MCP server without an Authorization header")
    this.loginStarting.add(name)
    try {
      this.logins.get(name)?.cancel()
      const info = await discoverMcpOAuth(client.config.url, client.authChallenge)
      if (this.closing) throw new Error("MCP manager closed")
      const login = await beginMcpOAuth(info, client.config.oauth)
      if (this.closing) { login.cancel(); throw new Error("MCP manager closed") }
      this.logins.set(name, login)
      void login.done.then(async success => {
        if (success && !this.closing && this.logins.get(name) === login) {
          await client.restart()
          this.onChange?.()
        }
      }).catch(() => {})
      return login
    } finally { this.loginStarting.delete(name) }
  }
}
