import type { ConfigMCP } from "../config/mcp"

// Curated catalog of popular MCP servers, skills, and plugins, modeled on the
// "marketplace" UX of Codex, Claude Code, and Gemini CLI. This is a static,
// reviewed list — `cg market add <id>` writes the chosen MCP server into the
// project's opencode.json (the existing MCP config surface). Nothing here is
// installed or executed at catalog-read time.

export type MarketKind = "mcp" | "skill" | "plugin"

export type MarketEntry = {
  id: string
  name: string
  kind: MarketKind
  category: string
  description: string
  /** Homepage or docs URL for the integration. */
  homepage?: string
  /** Environment variables the user must provide for this integration. */
  env?: { name: string; description: string }[]
  /** For MCP entries: the config snippet written to opencode.json. */
  mcp?: ConfigMCP.Info
  /** For skill/plugin entries: a short install hint. */
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
}
