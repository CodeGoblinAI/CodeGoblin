import path from "path"
import { applyEdits, modify } from "jsonc-parser"
import { Filesystem } from "../util/filesystem"
import { Process } from "../util/process"
import { which } from "../util/which"
import type { ConfigMCP } from "../config/mcp"

export type MarketKind = "mcp" | "skill" | "plugin"

export type MarketEntry = {
  id: string
  name: string
  kind: MarketKind
  category: string
  description: string
  homepage?: string
  env?: { name: string; description: string }[]
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
    env: [{ name: "SUPABASE_ACCESS_TOKEN", description: "Personal access token from the Supabase dashboard." }],
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
    env: [{ name: "NOTION_TOKEN", description: "Internal integration token from notion.so/my-integrations." }],
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
    const candidates = [
      path.join(baseDir, "codegoblin.jsonc"),
      path.join(baseDir, "codegoblin.json"),
      path.join(baseDir, "opencode.jsonc"),
      path.join(baseDir, "opencode.json"),
      path.join(baseDir, "config.json"),
      path.join(baseDir, ".codegoblin", "codegoblin.jsonc"),
      path.join(baseDir, ".codegoblin", "codegoblin.json"),
      path.join(baseDir, ".opencode", "opencode.jsonc"),
      path.join(baseDir, ".opencode", "opencode.json"),
    ]
    for (const candidate of candidates) {
      if (await Filesystem.exists(candidate)) return candidate
    }
    return candidates[0]
  },
  firebaseLoginCommand(): string[] {
    const npx =
      process.platform === "win32" ? (which("npx.cmd") ?? which("npx") ?? "npx.cmd") : (which("npx") ?? "npx")
    return [npx, "-y", "firebase-tools", "login"]
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
  /** Write a catalog MCP entry into the project config, returning the config path. */
  async addToConfig(entry: MarketEntry, baseDir: string): Promise<string> {
    if (entry.kind !== "mcp" || !entry.mcp) {
      throw new Error(`'${entry.id}' is not an MCP server.`)
    }
    const configPath = await Market.resolveConfigPath(baseDir)
    const text = (await Filesystem.exists(configPath)) ? await Filesystem.readText(configPath) : "{}"
    const edits = modify(text, ["mcp", entry.id], entry.mcp, {
      formattingOptions: { tabSize: 2, insertSpaces: true },
    })
    await Filesystem.write(configPath, applyEdits(text, edits))
    return configPath
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
