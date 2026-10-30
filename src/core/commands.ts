import { PROVIDERS, allSelections, resolveSelection, selectionsOfKind, KIND_LABEL, KIND_ORDER } from "./providers"
import { THEMES, isTheme } from "./theme"
import { isEffort, type Effort } from "./settings"
import { MEDIA_KINDS, type MediaKind } from "./media"

/**
 * Slash commands.
 *
 * Handled before anything reaches the model, so they cost nothing and always
 * work - even when a provider is down or a key is missing.
 */
export type CommandResult =
  | { kind: "message"; text: string }
  | { kind: "clear" }
  | { kind: "quit" }
  | { kind: "provider"; id: string }
  | { kind: "resume"; id?: string }
  | { kind: "compact" }
  | { kind: "usage" }
  | { kind: "balance"; provider?: string }
  | { kind: "account"; source?: "claude" | "cursor" }
  | { kind: "login"; source?: "cursor" }
  | { kind: "cli-login"; source: "claude" | "cursor" }
  | { kind: "import"; id?: string }
  | { kind: "undo" }
  | { kind: "redo" }
  | { kind: "status" }
  | { kind: "mcp" }
  | { kind: "skills" }
  | { kind: "plan"; text?: string }
  | { kind: "approvals" }
  | { kind: "boost"; text?: string }
  | { kind: "export"; path?: string }
  | { kind: "rename"; title: string }
  | { kind: "theme"; name?: string }
  | { kind: "thinking" }
  | { kind: "effort"; level?: Effort }
  | { kind: "agents"; name?: string }
  | { kind: "settings"; argument?: string }
  | { kind: "diff" }
  | { kind: "media"; media: MediaKind; line: string }
  | { kind: "memory"; action: "list" | "add" | "forget" | "clear"; text?: string }
  | { kind: "local"; argument: string }
  | { kind: "connect"; provider?: string }
  | { kind: "disconnect"; provider?: string }
  | { kind: "none" }

export const COMMANDS = [
  { name: "/usage", description: "session tokens/context and provider balance; Codex quotas via /account" },
  { name: "/balance", description: "refresh balance/quota: deepseek, moonshotai, tripo or elevenlabs" },
  { name: "/account", description: "subscription snapshots: codex, claude or cursor (dashboard)" },
  { name: "/login", description: "official sign-in: /login codex, /login claude or /login cursor" },
  { name: "/import", description: "copy a selected Codex text conversation for this project: /import codex" },
  { name: "/help", description: "show these commands" },
  { name: "/clear", description: "start a fresh conversation" },
  { name: "/model", description: "switch provider: /model zai" },
  { name: "/resume", description: "reopen a saved conversation" },
  { name: "/compact", description: "summarise the conversation to free context" },
  { name: "/undo", description: "put back the files the last turn changed" },
  { name: "/redo", description: "reapply what /undo took back" },
  { name: "/local", description: "local llama.cpp models: status, /local stop, /local tools on|off, /local context" },
  { name: "/connect", description: "connect a provider - pick one, paste its key" },
  { name: "/disconnect", description: "remove a CG API key, not a CLI/SDK sign-in - /disconnect tripo" },
  { name: "/memory", description: "what is remembered: /memory, /memory add ..., /memory forget <id>" },
  { name: "/status", description: "what this session is using right now" },
  { name: "/mcp", description: "MCP servers from codegoblin.jsonc, and the tools each offers" },
  { name: "/skills", description: "skills and custom commands, and where each comes from" },
  { name: "/plan", description: "plan before changing anything: /plan add dark mode, or /plan to switch it" },
  { name: "/approvals", description: "how much to ask before acting - opens a picker" },
  { name: "/mode", description: "approval mode (alias for /approvals), not named-agent selection" },
  { name: "/boost", description: "let the model use subagents: /boost a hard task, or /boost to switch it on" },
  { name: "/export", description: "save as markdown: /export, or /export notes/chat.md" },
  { name: "/rename", description: "retitle this conversation: /rename plan review" },
  { name: "/theme", description: "change colours: /theme midnight" },
  { name: "/thinking", description: "show or hide the model's reasoning" },
  { name: "/effort", description: "how hard a reasoning model thinks: /effort high" },
  { name: "/agents", description: "choose a named agent profile; /agents default resets" },
  { name: "/settings", description: "open settings, or /settings <model setting> <value>; omit value to reset" },
  { name: "/diff", description: "what this session changed, file by file" },
  { name: "/quit", description: "exit" },
]

export function isCommand(text: string): boolean {
  return text.trim().startsWith("/")
}

export const COMMAND_ALIASES: Record<string, string> = {
  "/agent": "/agents",
  "/models": "/model", "/themes": "/theme", "/shortcuts": "/help", "/keys": "/help",
  "/new": "/clear", "/reset": "/clear", "/sessions": "/resume", "/continue": "/resume",
  "/logout": "/disconnect", "/remove-key": "/disconnect", "/memories": "/memory",
  "/mcps": "/mcp", "/reasoning": "/effort", "/set": "/settings", "/changes": "/diff",
  "/exit": "/quit", "/q": "/quit",
  "/credits": "/balance",
  "/market": "/plugins", "/mcp-market": "/plugins", "/skills-market": "/plugins",
  "/upgrade": "/update", "/version": "/update", "/orgs": "/org", "/switch-org": "/org",
}
export const PENDING_COMMANDS: Record<string, string> = {
  "/variants": "Model-specific variants are not wired yet; /effort controls supported reasoning models.",
  "/plugins": "The plugin marketplace is not wired yet; /mcp and /skills show configured integrations.",
  "/update": "CG-Next's installer/updater is not wired yet. This is the source checkout, not the original cg installation.",
  "/editor": "External prompt editor is not wired yet.",
  "/warp": "Prompt warp is not wired yet.",
  "/widget": "The native status widget is not wired into CG-Next yet.",
  "/widget-settings": "Native widget settings are not wired yet.",
  "/org": "Organization switching is not wired yet; account access belongs to the selected provider.",
}
COMMANDS.push(...Object.keys(PENDING_COMMANDS).map((name) => ({ name, description: "not wired yet — " + PENDING_COMMANDS[name] })))

export function normalizeCommand(text: string): string {
  return text.replace(/^\/[^\s]+/, (name) => COMMAND_ALIASES[name] ?? name)
}

export function runCommand(text: string): CommandResult {
  const [name, ...rest] = normalizeCommand(text.trim()).split(/\s+/)
  const argument = rest.join(" ")
  if (name && PENDING_COMMANDS[name]) return { kind: "message", text: PENDING_COMMANDS[name]! }

  switch (name) {
    case "/account":
      if (!argument || argument === "codex") return { kind: "account" }
      if (argument === "claude" || argument === "claude-code") return { kind: "account", source: "claude" }
      if (argument === "cursor") return { kind: "account", source: "cursor" }
      return { kind: "message", text: "Use /account codex, /account claude or /account cursor" }
    case "/agent":
    case "/agents":
      return { kind: "agents", name: argument || undefined }
    case "/login":
      if (argument === "cursor") return { kind: "login", source: "cursor" }
      if (argument === "claude" || argument === "claude-code" || argument === "cursor-cli") return { kind: "cli-login", source: argument === "cursor-cli" ? "cursor" : "claude" }
      return argument === "codex" ? { kind: "login" } : { kind: "message", text: "Use /login codex, /login claude or /login cursor" }
    case "/import": {
      const [source, id, extra] = argument.split(/\s+/)
      return source === "codex" && !extra ? { kind: "import", id } : { kind: "message", text: "Use /import codex [session-id]; imports are new text-only conversations" }
    }
    case "/balance":
      return { kind: "balance", provider: argument || undefined }
    case "/help":
      return {
        kind: "message",
        text: COMMANDS.map((command) => `${command.name.padEnd(12)}${command.description}`).join(
          String.fromCharCode(10),
        ),
      }
    case "/clear":
    case "/new":
      return { kind: "clear" }
    case "/quit":
    case "/exit":
      return { kind: "quit" }
    case "/resume":
    case "/sessions":
    case "/continue":
      // An argument is a session id chosen from the list.
      return { kind: "resume", id: argument || undefined }
    case "/compact":
      return { kind: "compact" }
    case "/undo":
      return { kind: "undo" }
    case "/redo":
      return { kind: "redo" }
    // Not in COMMANDS on purpose. The original does not advertise these
    // either: you pick an image model and type, and the command only exists
    // so flags like --output and --dry-run have somewhere to live.
    case "/image":
    case "/audio":
    case "/model3d": {
      const media = MEDIA_KINDS.find((entry) => entry.command === name)!
      if (!argument) return { kind: "message", text: "usage: " + media.description }
      return { kind: "media", media: media.kind, line: text.trim() }
    }
    case "/memory": {
      const [action, ...rest] = argument.split(/\s+/)
      const remainder = rest.join(" ").trim()
      if (!argument) return { kind: "memory", action: "list" }
      if (action === "add") {
        if (!remainder) return { kind: "message", text: "usage: /memory add something worth remembering" }
        return { kind: "memory", action: "add", text: remainder }
      }
      if (action === "forget") {
        if (!remainder) return { kind: "message", text: "usage: /memory forget <id>" }
        return { kind: "memory", action: "forget", text: remainder }
      }
      if (action === "clear") return { kind: "memory", action: "clear" }
      // Anything else is a search, which is what someone typing words after
      // /memory almost always means.
      return { kind: "memory", action: "list", text: argument }
    }
    case "/connect":
      if (argument === "cursor") return { kind: "message", text: "Use /login cursor for SDK user-plan sign-in, or /connect cursor-api for an existing key" }
      return { kind: "connect", provider: argument || undefined }
    // Bare opens the picker, the way /connect already does. Naming the
    // provider from memory was the only way in, and the id is not always the
    // label - "zai" for GLM, "google" for Gemini.
    case "/disconnect":
      if (argument === "cursor") return { kind: "message", text: "Revoke the SDK user-plan key in Cursor's account dashboard. /disconnect cursor-api only removes a CG-stored API key, not SDK/CLI sign-in." }
      return { kind: "disconnect", provider: argument || undefined }
    case "/local":
      return { kind: "local", argument }
    case "/status":
      return { kind: "status" }
    case "/usage":
      return { kind: "usage" }
    case "/mcp":
      return { kind: "mcp" }
    case "/skills":
      return { kind: "skills" }
    case "/plan":
      return { kind: "plan", text: argument || undefined }
    case "/approvals":
    case "/mode":
      return { kind: "approvals" }
    case "/boost":
      return { kind: "boost", text: argument || undefined }
    case "/export":
      return { kind: "export", path: argument || undefined }
    // No argument opens the panel; a model setting can also be changed directly.
    case "/settings":
    case "/set":
      return argument ? { kind: "settings", argument } : { kind: "settings" }
    case "/diff":
    case "/changes":
      return { kind: "diff" }
    case "/thinking":
      return { kind: "thinking" }
    case "/effort": {
      if (!argument) return { kind: "effort" }
      if (!isEffort(argument)) {
        return { kind: "message", text: `unknown effort: ${argument}  (auto, low, medium, high)` }
      }
      return { kind: "effort", level: argument }
    }
    // Mouse lives in Settings, not the command list: a toggle nobody can find
    // is bad, but a slash entry for it invited exactly the confusion it caused.
    case "/rename": {
      if (!argument) return { kind: "message", text: "usage: /rename a shorter title" }
      return { kind: "rename", title: argument }
    }
    // Bare opens the picker. Printing the list and asking for it to be typed
    // back made the names something to memorise, which is what a list of five
    // colour schemes should never be.
    case "/theme": {
      if (!argument) return { kind: "theme" }
      if (!isTheme(argument)) return { kind: "message", text: `unknown theme: ${argument}  (try /theme)` }
      return { kind: "theme", name: argument }
    }
    case "/model": {
      if (!argument) {
        const NEWLINE = String.fromCharCode(10)
        // Grouped, because the list is no longer all one thing: picking a
        // model is now also picking what a prompt turns into.
        const sections = KIND_ORDER.map((kind) => {
          const rows = selectionsOfKind(kind)
          if (!rows.length) return ""
          return (
            KIND_LABEL[kind] +
            NEWLINE +
            rows
              .map((s) => "  " + (s.provider.id + "/" + s.model.id).padEnd(34) + s.provider.label + " " + s.model.label)
              .join(NEWLINE)
          )
        }).filter(Boolean)
        return {
          kind: "message",
          text: "usage: /model <id>, or /model image to narrow" + NEWLINE + NEWLINE + sections.join(NEWLINE + NEWLINE),
        }
      }
      if (!resolveSelection(argument)) return { kind: "message", text: `unknown model: ${argument}  (try /model)` }
      return { kind: "provider", id: argument }
    }
    default:
      return { kind: "message", text: `unknown command: ${name}  (try /help)` }
  }
}
