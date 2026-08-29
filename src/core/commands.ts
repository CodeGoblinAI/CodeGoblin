import { PROVIDERS, allSelections, resolveSelection, selectionsOfKind, KIND_LABEL, KIND_ORDER } from "./providers"
import { THEMES, isTheme } from "./theme"
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
  | { kind: "undo" }
  | { kind: "redo" }
  | { kind: "status" }
  | { kind: "export"; path?: string }
  | { kind: "rename"; title: string }
  | { kind: "theme"; name: string }
  | { kind: "thinking" }
  | { kind: "media"; media: MediaKind; line: string }
  | { kind: "memory"; action: "list" | "add" | "forget" | "clear"; text?: string }
  | { kind: "connect"; provider?: string }
  | { kind: "disconnect"; provider: string }
  | { kind: "none" }

export const COMMANDS = [
  { name: "/help", description: "show these commands" },
  { name: "/clear", description: "start a fresh conversation" },
  { name: "/model", description: "switch provider: /model zai" },
  { name: "/resume", description: "reopen a saved conversation" },
  { name: "/compact", description: "summarise the conversation to free context" },
  { name: "/undo", description: "put back the files the last turn changed" },
  { name: "/redo", description: "reapply what /undo took back" },
  { name: "/connect", description: "connect a provider - pick one, paste its key" },
  { name: "/disconnect", description: "remove a stored key: /disconnect tripo" },
  { name: "/memory", description: "what is remembered: /memory, /memory add ..., /memory forget <id>" },
  { name: "/status", description: "what this session is using right now" },
  { name: "/export", description: "save as markdown: /export, or /export notes/chat.md" },
  { name: "/rename", description: "retitle this conversation: /rename plan review" },
  { name: "/theme", description: "change colours: /theme midnight" },
  { name: "/thinking", description: "show or hide the model's reasoning" },
  { name: "/quit", description: "exit" },
]

export function isCommand(text: string): boolean {
  return text.trim().startsWith("/")
}

export function runCommand(text: string): CommandResult {
  const [name, ...rest] = text.trim().split(/\s+/)
  const argument = rest.join(" ")

  switch (name) {
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
      return { kind: "connect", provider: argument || undefined }
    case "/disconnect": {
      if (!argument) return { kind: "message", text: "usage: /disconnect <provider>" }
      return { kind: "disconnect", provider: argument }
    }
    case "/status":
      return { kind: "status" }
    case "/export":
      return { kind: "export", path: argument || undefined }
    case "/thinking":
      return { kind: "thinking" }
    case "/rename": {
      if (!argument) return { kind: "message", text: "usage: /rename a shorter title" }
      return { kind: "rename", title: argument }
    }
    case "/theme": {
      if (!argument) {
        const available = Object.entries(THEMES)
          .map(([name, theme]) => name.padEnd(12) + theme.label)
          .join(String.fromCharCode(10))
        return { kind: "message", text: "usage: /theme <name>" + String.fromCharCode(10) + available }
      }
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
