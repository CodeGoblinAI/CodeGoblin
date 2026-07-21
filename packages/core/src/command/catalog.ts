export type SlashCommandSurface = "tui" | "web"

export type SlashCommandDescriptor = {
  name: string
  aliases: readonly string[]
  title: string
  description: string
  category: string
  surfaces: readonly SlashCommandSurface[]
}

export const SHARED_SLASH_COMMANDS = [
  {
    name: "resume",
    aliases: ["sessions", "continue"],
    title: "Resume session",
    description: "Open a previous session",
    category: "Session",
    surfaces: ["tui", "web"],
  },
  {
    name: "clear",
    aliases: ["new", "reset"],
    title: "Clear and start a new session",
    description: "Start a fresh session",
    category: "Session",
    surfaces: ["tui", "web"],
  },
  {
    name: "model",
    aliases: ["models"],
    title: "Switch model",
    description: "Choose the model for this session",
    category: "Agent",
    surfaces: ["tui", "web"],
  },
  {
    name: "mode",
    aliases: ["agents", "agent"],
    title: "Switch mode",
    description: "Choose the active agent or mode",
    category: "Agent",
    surfaces: ["tui", "web"],
  },
  {
    name: "mcp",
    aliases: ["mcps"],
    title: "Toggle MCPs",
    description: "Connect or disconnect MCP servers",
    category: "Agent",
    surfaces: ["tui", "web"],
  },
  {
    name: "effort",
    aliases: ["reasoning"],
    title: "Select reasoning effort",
    description: "Choose the model's reasoning effort",
    category: "Agent",
    surfaces: ["tui", "web"],
  },
  {
    name: "variants",
    aliases: [],
    title: "Switch model variant",
    description: "Choose a model-specific variant",
    category: "Agent",
    surfaces: ["tui", "web"],
  },
  {
    name: "connect",
    aliases: [],
    title: "Connect a model",
    description: "Connect a provider or account",
    category: "Provider",
    surfaces: ["tui", "web"],
  },
  {
    name: "logout",
    aliases: ["disconnect", "remove-key"],
    title: "Remove saved provider credentials",
    description: "Remove saved provider credentials",
    category: "Provider",
    surfaces: ["tui", "web"],
  },
  {
    name: "usage",
    aliases: [],
    title: "View usage",
    description: "View tokens, spend, balances, and provider quota",
    category: "CodeGoblin",
    surfaces: ["tui", "web"],
  },
  {
    name: "status",
    aliases: [],
    title: "View status",
    description: "View connected services and runtime status",
    category: "System",
    surfaces: ["tui", "web"],
  },
  {
    name: "settings",
    aliases: [],
    title: "Settings",
    description: "Open CodeGoblin settings",
    category: "System",
    surfaces: ["tui", "web"],
  },
  {
    name: "theme",
    aliases: ["themes"],
    title: "Switch theme",
    description: "Choose the interface theme",
    category: "System",
    surfaces: ["tui", "web"],
  },
  {
    name: "help",
    aliases: ["shortcuts", "keys"],
    title: "Keyboard shortcuts",
    description: "Show available commands and shortcuts",
    category: "System",
    surfaces: ["tui", "web"],
  },
  {
    name: "memory",
    aliases: ["memories"],
    title: "CodeGoblin memory",
    description: "Browse, pin, archive, and add CodeGoblin memories",
    category: "CodeGoblin",
    surfaces: ["tui", "web"],
  },
  {
    name: "plugins",
    aliases: ["market", "mcp-market", "skills-market"],
    title: "CodeGoblin market",
    description: "Add, connect, authenticate, or disconnect MCP servers",
    category: "CodeGoblin",
    surfaces: ["tui", "web"],
  },
  {
    name: "update",
    aliases: ["upgrade", "version"],
    title: "Check for updates",
    description: "Check for and install CodeGoblin updates",
    category: "System",
    surfaces: ["tui", "web"],
  },
] as const satisfies readonly SlashCommandDescriptor[]

export function getSlashCommand(name: string) {
  const normalized = name.replace(/^\//, "").toLowerCase()
  return (SHARED_SLASH_COMMANDS as readonly SlashCommandDescriptor[]).find(
    (command) => command.name === normalized || command.aliases.includes(normalized),
  )
}

export function slashCommandNames(surface: SlashCommandSurface) {
  return SHARED_SLASH_COMMANDS.filter((command) => command.surfaces.includes(surface)).flatMap((command) => [
    command.name,
    ...command.aliases,
  ])
}

export function slashCommandProps(name: string) {
  const command = getSlashCommand(name)
  if (!command) throw new Error(`Unknown shared slash command: ${name}`)
  return {
    name: command.name,
    aliases: [...command.aliases],
    title: command.title,
    description: command.description,
    category: command.category,
  }
}
