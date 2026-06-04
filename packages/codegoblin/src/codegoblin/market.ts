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
    const cmd = Market.firebaseLoginCommand()
    if (process.platform === "win32") {
      Process.spawn(["cmd", "/c", "start", "Firebase Login", "cmd", "/k", ...cmd], { cwd, stdin: "ignore" })
      return
    }
    if (process.platform === "darwin") {
      Process.spawn(["open", "-a", "Terminal", ...cmd], { cwd, stdin: "ignore" })
      return
    }
    Process.spawn(cmd, { cwd, stdin: "inherit", stdout: "inherit", stderr: "inherit" })
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
