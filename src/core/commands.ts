import { PROVIDERS, allSelections, resolveSelection } from "./providers"

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
  | { kind: "none" }

export const COMMANDS = [
  { name: "/help", description: "show these commands" },
  { name: "/new", description: "start a fresh conversation" },
  { name: "/model", description: "switch provider: /model zai" },
  { name: "/resume", description: "reopen a saved conversation" },
  { name: "/compact", description: "summarise the conversation to free context" },
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
    case "/model": {
      if (!argument) {
        const available = allSelections()
          .map((s) => `${(s.provider.id + "/" + s.model.id).padEnd(28)}${s.provider.label} ${s.model.label}`)
          .join(String.fromCharCode(10))
        return { kind: "message", text: `usage: /model <id>${String.fromCharCode(10)}${available}` }
      }
      if (!resolveSelection(argument)) return { kind: "message", text: `unknown model: ${argument}  (try /model)` }
      return { kind: "provider", id: argument }
    }
    default:
      return { kind: "message", text: `unknown command: ${name}  (try /help)` }
  }
}
