import path from "path"
import { applyEdits, modify, parse as parseJsonc } from "jsonc-parser"
import { Global } from "@codegoblin/core/global"
import { Filesystem } from "../util/filesystem"
import { Process } from "../util/process"
import { which } from "../util/which"
import type { ConfigMCP } from "../config/mcp"
import { augmentNotionEnvironment, notionOpenApiHeaders } from "../mcp/notion-env"

export type MarketKind = "mcp" | "skill" | "plugin"

export type MarketEntry = {
  id: string
  name: string
  kind: MarketKind
  category: string
  description: string
  homepage?: string
  env?: { name: string; label?: string; description: string; link?: string }[]
  /** True when the entry is installed globally or in the project config. */
  installed?: boolean
  /** True when the entry is installed but still has missing or placeholder secrets. */
  needsEnv?: boolean
  mcp?: ConfigMCP.Info
  install?: string
}

export const MarketCatalog: MarketEntry[] = [
  {
    id: "supabase",
    name: "Supabase",
    kind: "mcp",
    category: "Database & Backend",
    description: "Manage Supabase projects, run SQL, inspect schema, and read logs.",
    homepage: "https://supabase.com/docs/guides/getting-started/mcp",
    env: [
      {
        name: "SUPABASE_ACCESS_TOKEN",
        label: "Supabase Access Token",
        description: "Personal access token from the Supabase dashboard.",
        link: "https://supabase.com/dashboard/account/tokens",
      },
    ],
    mcp: {
      type: "local",
      command: ["npx", "-y", "@supabase/mcp-server-supabase@latest"],
      environment: { SUPABASE_ACCESS_TOKEN: "${SUPABASE_ACCESS_TOKEN}" },
      enabled: true,
    },
  },
  {
    id: "playwright",
    name: "Playwright",
    kind: "mcp",
    category: "Browser & Testing",
    description: "Drive a real browser: navigate, click, type, and capture pages for end-to-end testing.",
    homepage: "https://github.com/microsoft/playwright-mcp",
    mcp: {
      type: "local",
      command: ["npx", "-y", "@playwright/mcp@latest"],
      enabled: true,
    },
  },
  {
    id: "firebase",
    name: "Firebase",
    kind: "mcp",
    category: "Database & Backend",
    description: "Interact with Firebase projects: Firestore, Auth, and project configuration.",
    homepage: "https://firebase.google.com/docs/cli/mcp-server",
    mcp: {
      type: "local",
      command: ["npx", "-y", "firebase-tools@latest", "experimental:mcp"],
      enabled: true,
    },
  },
  {
    id: "notion",
    name: "Notion",
    kind: "mcp",
    category: "Productivity",
    description: "Read and write Notion pages, databases, and blocks.",
    homepage: "https://github.com/makenotion/notion-mcp-server",
    env: [
      {
        name: "NOTION_TOKEN",
        label: "Notion API Token",
        description:
          "Internal integration token from Notion. Create one at notion.so/profile/integrations, then share the pages or databases you want the agent to access with that integration.",
        link: "https://www.notion.so/profile/integrations",
      },
    ],
    mcp: {
      type: "local",
      command: ["npx", "-y", "@notionhq/notion-mcp-server"],
      environment: { NOTION_TOKEN: "${NOTION_TOKEN}" },
      enabled: true,
    },
  },
  {
    id: "github",
    name: "GitHub",
    kind: "mcp",
    category: "Dev & Source Control",
    description: "Search code, manage issues and pull requests, and inspect repositories on GitHub.",
    homepage: "https://github.com/github/github-mcp-server",
    mcp: {
      type: "remote",
      url: "https://api.githubcopilot.com/mcp/",
      enabled: true,
    },
  },
  {
    id: "context7",
    name: "Context7",
    kind: "mcp",
    category: "Docs & Knowledge",
    description: "Pull up-to-date, version-specific library documentation and code examples on demand.",
    homepage: "https://github.com/upstash/context7",
    mcp: {
      type: "local",
      command: ["npx", "-y", "@upstash/context7-mcp@latest"],
      enabled: true,
    },
  },
  {
    id: "sentry",
    name: "Sentry",
    kind: "mcp",
    category: "Observability",
    description: "Inspect Sentry issues, traces, and releases to debug production errors.",
    homepage: "https://docs.sentry.io/product/sentry-mcp/",
    mcp: {
      type: "remote",
      url: "https://mcp.sentry.dev/mcp",
      enabled: true,
    },
  },
  {
    id: "filesystem",
    name: "Filesystem",
    kind: "mcp",
    category: "Local Tools",
    description: "Sandboxed file operations over an allowlisted directory.",
    homepage: "https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem",
    mcp: {
      type: "local",
      command: ["npx", "-y", "@modelcontextprotocol/server-filesystem", "${PWD}"],
      enabled: true,
    },
  },
]

const CONFIG_FILE_NAMES = ["config.json", "opencode.json", "opencode.jsonc", "codegoblin.json", "codegoblin.jsonc"] as const

function configCandidates(baseDir: string): string[] {
  return [
    ...CONFIG_FILE_NAMES.map((name) => path.join(baseDir, name)),
    path.join(baseDir, ".codegoblin", "codegoblin.jsonc"),
    path.join(baseDir, ".codegoblin", "codegoblin.json"),
    path.join(baseDir, ".opencode", "opencode.jsonc"),
    path.join(baseDir, ".opencode", "opencode.json"),
  ]
}

export const Market = {
  list(filter?: { kind?: MarketKind; category?: string }): MarketEntry[] {
    return MarketCatalog.filter((entry) => {
      if (filter?.kind && entry.kind !== filter.kind) return false
      if (filter?.category && entry.category.toLowerCase() !== filter.category.toLowerCase()) return false
      return true
    })
  },
  get(id: string): MarketEntry | undefined {
    return MarketCatalog.find((entry) => entry.id === id.toLowerCase())
  },
  categories(): string[] {
    return [...new Set(MarketCatalog.map((entry) => entry.category))].sort()
  },
  async resolveConfigPath(baseDir: string): Promise<string> {
    for (const candidate of configCandidates(baseDir)) {
      if (await Filesystem.exists(candidate)) return candidate
    }
    return path.join(baseDir, "codegoblin.jsonc")
  },
  async resolveGlobalConfigPath(): Promise<string> {
    return Market.resolveConfigPath(Global.Path.config)
  },
  /** Find which config file owns an MCP entry (last matching file wins, same as Config merge order). */
  async findMcpConfigPath(id: string, baseDir: string): Promise<string | undefined> {
    const candidates = configCandidates(baseDir)
    for (let index = candidates.length - 1; index >= 0; index--) {
      const configPath = candidates[index]!
      if (!(await Filesystem.exists(configPath))) continue
      const text = await Filesystem.readText(configPath)
      const parsed = parseJsonc(text) as { mcp?: Record<string, unknown> } | undefined
      if (parsed?.mcp?.[id] !== undefined) return configPath
    }
    return undefined
  },
  async readMergedMcpFromDir(baseDir: string): Promise<Record<string, ConfigMCP.Info>> {
    let merged: Record<string, ConfigMCP.Info> = {}
    for (const configPath of configCandidates(baseDir)) {
      if (!(await Filesystem.exists(configPath))) continue
      const text = await Filesystem.readText(configPath)
      const parsed = parseJsonc(text) as { mcp?: Record<string, ConfigMCP.Info> } | undefined
      if (parsed?.mcp) merged = { ...merged, ...parsed.mcp }
    }
    return merged
  },
  async preferredWriteConfigPath(baseDir: string, id?: string): Promise<string> {
    if (id) {
      const existing = await Market.findMcpConfigPath(id, baseDir)
      if (existing) return existing
    }
    const branded = [path.join(baseDir, "codegoblin.jsonc"), path.join(baseDir, "codegoblin.json")]
    for (const candidate of branded) {
      if (await Filesystem.exists(candidate)) return candidate
    }
    return path.join(baseDir, "codegoblin.jsonc")
  },
  firebaseToolsCommand(): string[] {
    const npx =
      process.platform === "win32" ? (which("npx.cmd") ?? which("npx") ?? "npx.cmd") : (which("npx") ?? "npx")
    return [npx, "-y", "firebase-tools"]
  },
  firebaseLoginCommand(): string[] {
    return [...Market.firebaseToolsCommand(), "login"]
  },
  /** Returns whether the Firebase CLI already has a logged-in user (shared with the MCP server). */
  async readFirebaseLoginStatus(): Promise<{ loggedIn: boolean; email?: string }> {
    try {
      const out = await Process.text([...Market.firebaseToolsCommand(), "login:list"], {
        nothrow: true,
        timeout: 30_000,
      })
      const text = out.text.trim()
      if (!text || /no authorized accounts/i.test(text)) return { loggedIn: false }
      const email =
        text.match(/logged in as[:\s]+([^\s]+@[^\s]+)/i)?.[1] ??
        text.match(/([^\s]+@[^\s]+)/)?.[1]
      return { loggedIn: true, email }
    } catch {
      return { loggedIn: false }
    }
  },
  /** Open Firebase CLI login in a new terminal so the user can complete browser auth. */
  startFirebaseLogin(cwd?: string): void {
    const spawn = firebaseLoginTerminalCommand(process.platform, Market.firebaseLoginCommand())
    const opts =
      spawn.stdin === "inherit"
        ? ({ cwd, stdin: "inherit", stdout: "inherit", stderr: "inherit" } as const)
        : ({ cwd, stdin: "ignore" } as const)
    Process.spawn(spawn.argv, opts)
  },
  /** OpenAPI auth headers required by @notionhq/notion-mcp-server on some platforms (see makenotion/notion-mcp-server#95). */
  notionOpenApiHeaders,
  /** Ensure Notion MCP subprocess receives Authorization headers, not only NOTION_TOKEN. */
  augmentNotionEnvironment,
  /** Substitute `${VAR}` placeholders in MCP environment with provided secret values. */
  materializeMcp(entry: MarketEntry, env?: Record<string, string>): ConfigMCP.Info {
    if (!entry.mcp) throw new Error(`'${entry.id}' is not an MCP server.`)
    const mcp = structuredClone(entry.mcp)
    if (mcp.type !== "local" || !mcp.environment) return mcp
    const next: Record<string, string> = { ...mcp.environment }
    for (const [key, value] of Object.entries(next)) {
      const match = /^\$\{([^}]+)\}$/.exec(value)
      const varName = match?.[1] ?? key
      const provided = env?.[varName]?.trim() ?? env?.[key]?.trim()
      if (provided) next[key] = provided
    }
    return {
      ...mcp,
      environment: entry.id === "notion" ? augmentNotionEnvironment(next) : next,
    }
  },
  validateEnv(entry: MarketEntry, env?: Record<string, string>): string | undefined {
    for (const item of entry.env ?? []) {
      if (!env?.[item.name]?.trim()) {
        return `${item.label ?? item.name} is required.`
      }
    }
    return undefined
  },
  /** True when a catalog entry requires secrets that are missing or still `${VAR}` placeholders. */
  mcpNeedsEnv(entry: MarketEntry, installed?: ConfigMCP.Info): boolean {
    if (!entry.env?.length) return false
    if (!installed) return true
    if (installed.type !== "local") return false
    const environment = installed.environment ?? {}
    for (const field of entry.env) {
      const value = environment[field.name]?.trim()
      if (!value) return true
      if (/^\$\{[^}]+\}$/.test(value)) return true
    }
    return false
  },
  async readGlobalMcp(): Promise<Record<string, ConfigMCP.Info>> {
    return Market.readMergedMcpFromDir(Global.Path.config)
  },
  async listWithStatus(filter?: { kind?: MarketKind; category?: string }, projectDir?: string): Promise<MarketEntry[]> {
    const installed = {
      ...(await Market.readGlobalMcp()),
      ...(projectDir ? await Market.readMergedMcpFromDir(projectDir) : {}),
    }
    return Market.list(filter).map((entry) => ({
      ...entry,
      needsEnv: Market.mcpNeedsEnv(entry, installed[entry.id]),
      installed: installed[entry.id] !== undefined,
    }))
  },
  /** Write a catalog MCP entry into the global CodeGoblin config (same scope as `cg mcp add` → Global). */
  async addToGlobalConfig(entry: MarketEntry, env?: Record<string, string>): Promise<string> {
    return Market.addToConfig(entry, Global.Path.config, env)
  },
  /** Write a catalog MCP entry into the project config, returning the config path. */
  async addToConfig(entry: MarketEntry, baseDir: string, env?: Record<string, string>): Promise<string> {
    if (entry.kind !== "mcp" || !entry.mcp) {
      throw new Error(`'${entry.id}' is not an MCP server.`)
    }
    const missing = Market.validateEnv(entry, env)
    if (missing) throw new Error(missing)
    const mcp = Market.materializeMcp(entry, env)
    const configPath = await Market.preferredWriteConfigPath(baseDir, entry.id)
    const text = (await Filesystem.exists(configPath)) ? await Filesystem.readText(configPath) : "{}"
    const edits = modify(text, ["mcp", entry.id], mcp, {
      formattingOptions: { tabSize: 2, insertSpaces: true },
    })
    await Filesystem.write(configPath, applyEdits(text, edits))
    return configPath
  },
  /** Remove a catalog MCP entry from every config file in a directory that defines it. */
  async removeFromConfigDir(id: string, baseDir: string): Promise<string | undefined> {
    let removedPath: string | undefined
    for (const configPath of configCandidates(baseDir)) {
      if (!(await Filesystem.exists(configPath))) continue
      const text = await Filesystem.readText(configPath)
      const parsed = parseJsonc(text) as { mcp?: Record<string, unknown> } | undefined
      if (parsed?.mcp?.[id] === undefined) continue
      const edits = modify(text, ["mcp", id], undefined, {
        formattingOptions: { tabSize: 2, insertSpaces: true },
      })
      await Filesystem.write(configPath, applyEdits(text, edits))
      removedPath = configPath
    }
    return removedPath
  },
  /** Remove a catalog MCP entry from a config directory. */
  async removeFromConfig(id: string, baseDir: string): Promise<string> {
    const removedPath = await Market.removeFromConfigDir(id, baseDir)
    if (!removedPath) {
      throw new Error(`MCP '${id}' is not installed.`)
    }
    return removedPath
  },
  /** Remove from global config, then project config if still present. */
  async removeFromAllScopes(
    id: string,
    projectDir?: string,
  ): Promise<{ configPath?: string; removedFromConfig: boolean }> {
    let removedPath = await Market.removeFromConfigDir(id, Global.Path.config)
    if (projectDir) {
      const projectPath = await Market.removeFromConfigDir(id, projectDir)
      if (projectPath) removedPath = projectPath
    }
    return { configPath: removedPath, removedFromConfig: !!removedPath }
  },
  /** Remove a catalog MCP entry from the global CodeGoblin config. */
  async removeFromGlobalConfig(id: string): Promise<string> {
    return Market.removeFromConfig(id, Global.Path.config)
  },
}

export type FirebaseLoginSpawn = { argv: string[]; stdin: "ignore" | "inherit" }

function shellQuote(value: string) {
  return /^[\w./-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`
}

function shellCommand(cmd: string[]) {
  return cmd.map(shellQuote).join(" ")
}

/**
 * Builds the command that runs `cmd` in a visible terminal so the user can complete Firebase's
 * browser auth.
 *
 * - **Windows**: a new `cmd` window via `start`.
 * - **macOS**: AppleScript `do script` — plain `open -a Terminal <args>` opens the args as files
 *   instead of running them.
 * - **Linux**: the first available terminal emulator; falls back to inheriting the server's stdio
 *   when none is found (best effort when running on a TTY).
 */
export function firebaseLoginTerminalCommand(
  platform: NodeJS.Platform,
  cmd: string[],
  whichFn: (command: string) => string | null = which,
): FirebaseLoginSpawn {
  if (platform === "win32") {
    return { argv: ["cmd", "/c", "start", "Firebase Login", "cmd", "/k", ...cmd], stdin: "ignore" }
  }
  if (platform === "darwin") {
    const shellCommand = cmd.map(shellQuote).join(" ")
    const appleScript = `tell application "Terminal" to do script "${shellCommand.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
    return {
      argv: ["osascript", "-e", 'tell application "Terminal" to activate', "-e", appleScript],
      stdin: "ignore",
    }
  }
  const gnome = whichFn("gnome-terminal")
  if (gnome) return { argv: [gnome, "--", ...cmd], stdin: "ignore" }
  const konsole = whichFn("konsole")
  if (konsole) return { argv: [konsole, "-e", shellCommand(cmd)], stdin: "ignore" }
  const xterm = whichFn("x-terminal-emulator") ?? whichFn("xterm")
  if (xterm) return { argv: [xterm, "-e", shellCommand(cmd)], stdin: "ignore" }
  return { argv: [...cmd], stdin: "inherit" }
}
