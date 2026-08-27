/**
 * CodeGoblin TUI.
 *
 *   bun run tui                  # DeepSeek by default
 *   bun run tui -- --provider zai
 *
 * Raw ANSI, no framework. Keys come from the environment
 * (DEEPSEEK_API_KEY, ZAI_API_KEY, ...) or the existing CodeGoblin auth.json.
 */
import { ansi, theme, dim } from "./ansi"
import { parseKeys } from "./keys"
import { WORDMARK, WORDMARK_WIDTH, COMPACT } from "./wordmark"
import { PROVIDERS, DEFAULT_PROVIDER } from "../core/providers"
import { apiKey } from "../core/auth"
import { runAgent, type Message } from "../core/agent"
import { isCommand, runCommand } from "../core/commands"
import * as sessions from "../core/sessions"

const argv = process.argv.slice(2)
const providerId = argv[argv.indexOf("--provider") + 1] ?? DEFAULT_PROVIDER
let provider = PROVIDERS[providerId] ?? PROVIDERS[DEFAULT_PROVIDER]!
let key = apiKey(provider.id)

const out = process.stdout
const messages: Message[] = [
  {
    role: "system",
    content:
      "You are CodeGoblin, a coding agent. You have tools to read, list and write files " +
      "in the user's working directory. Prefer reading before editing. Be concise.",
  },
]

/** What the user sees, kept separate from what the model sees. */
type Entry = { kind: "user" | "agent" | "tool"; text: string }
const transcript: Entry[] = []
let input = ""
let cursor = 0
const history: string[] = []
let historyIndex = -1
let scroll = 0
let streaming = false
let session = sessions.create(provider.id)
let status = key ? "" : `no key for ${provider.label} — set ${provider.id.toUpperCase()}_API_KEY`

const size = () => ({ cols: out.columns ?? 80, rows: out.rows ?? 24 })
const centre = (text: string, width: number) => " ".repeat(Math.max(0, Math.floor(width))) + text

/** Wrap on word boundaries so the transcript stays readable at any width. */
function wrap(text: string, width: number): string[] {
  const result: string[] = []
  for (const paragraph of text.split("\n")) {
    if (!paragraph) { result.push(""); continue }
    let line = ""
    for (const word of paragraph.split(" ")) {
      if (line && (line + " " + word).length > width) { result.push(line); line = word }
      else line = line ? line + " " + word : word
    }
    if (line) result.push(line)
  }
  return result
}

function render() {
  const { cols, rows } = size()
  const width = Math.max(20, cols - 6)
  const lines: string[] = []

  if (transcript.length === 0) {
    const wide = cols >= WORDMARK_WIDTH + 4
    const art = wide ? WORDMARK : [COMPACT]
    const gutter = (cols - (wide ? WORDMARK_WIDTH : COMPACT.length)) / 2
    lines.push("")
    for (const row of art) lines.push(theme.goblin + centre(row, gutter) + ansi.reset)
    lines.push("")
    lines.push(theme.gold + centre("your local AI goblin for code, images and agents", (cols - 47) / 2) + ansi.reset)
  } else {
    for (const entry of transcript) {
      if (entry.kind === "tool") {
        // Tool output can be several lines; push each so the height count
        // stays honest and the status line is not pushed off screen.
        const toolLines = entry.text.split(String.fromCharCode(10))
        for (const [index, toolLine] of toolLines.entries()) {
          const prefix = index === 0 ? "  ⚙ " : "    "
          for (const piece of wrap(toolLine, width)) {
            lines.push(theme.muted + prefix + piece + ansi.reset)
          }
        }
        lines.push("")
        continue
      }
      const isUser = entry.kind === "user"
      const accent = isUser ? theme.gold : theme.goblin
      lines.push(accent + "  " + (isUser ? "you" : provider.label.toLowerCase()) + ansi.reset)
      for (const line of wrap(entry.text, width)) {
        lines.push(accent + "  │ " + ansi.reset + theme.text + line + ansi.reset)
      }
      lines.push("")
    }
  }

  // Keep the newest content visible.
  const composerHeight = 4
  const room = Math.max(1, rows - composerHeight - 1)
  // scroll counts lines back from the newest.
  const maxScroll = Math.max(0, lines.length - room)
  scroll = Math.min(scroll, maxScroll)
  const cut = lines.length - room - scroll
  const body = lines.length > room ? lines.slice(Math.max(0, cut), Math.max(0, cut) + room) : lines
  while (body.length < room) body.push("")

  const inner = Math.max(10, cols - 4)
  const shown = streaming
    ? `${dim}goblin is thinking… esc to quit${ansi.reset}`
    : input
      ? input.slice(0, cursor) + "█" + input.slice(cursor)
      : `${dim}ask the goblin anything…${ansi.reset}`

  body.push(theme.border + "  " + "─".repeat(inner) + ansi.reset)
  body.push(theme.goblin + "  │ " + ansi.reset + theme.text + shown + ansi.reset)
  body.push(theme.border + "  " + "─".repeat(inner) + ansi.reset)

  const left = status || `${provider.label} · ${provider.model}`
  const right = scroll > 0 ? `scrolled ${scroll}  ·  pgdn` : "ctrl+c quit"
  // Pad from the plain text; the coloured string is longer than it looks.
  const plain = "  " + left
  const padded = plain.padEnd(Math.max(plain.length + 1, cols - right.length - 2))
  body.push(dim + padded + ansi.reset + theme.muted + right + ansi.reset)

  out.write(ansi.clear + body.join("\n"))
}

async function send() {
  const text = input.trim()
  if (!text || streaming) return
  if (!key) { status = `no key for ${provider.label}`; render(); return }

  if (isCommand(text)) {
    input = ""
    const result = runCommand(text)
    if (result.kind === "quit") return shutdown()
    if (result.kind === "clear") {
      transcript.length = 0
      messages.length = 1
      session = sessions.create(provider.id)
      status = "new conversation"
    }
    if (result.kind === "message") transcript.push({ kind: "tool", text: result.text })
    if (result.kind === "provider") {
      provider = PROVIDERS[result.id]!
      key = apiKey(provider.id)
      status = `switched to ${provider.label}`
    }
    if (result.kind === "sessions") {
      const saved = await sessions.list(10)
      transcript.push({
        kind: "tool",
        text: saved.length
          ? saved.map((entry) => `${entry.id}  ${entry.title}`).join(String.fromCharCode(10))
          : "no saved sessions yet",
      })
    }
    render()
    return
  }

  input = ""
  messages.push({ role: "user", content: text })
  transcript.push({ kind: "user", text })
  streaming = true
  scroll = 0
  status = ""
  render()

  let current: Entry | undefined
  try {
    for await (const event of runAgent({ provider, apiKey: key, messages, root: process.cwd() })) {
      if (event.type === "text") {
        if (!current || current.kind !== "agent") {
          current = { kind: "agent", text: "" }
          transcript.push(current)
        }
        current.text += event.delta
      }
      if (event.type === "tool_start") {
        current = undefined
        transcript.push({ kind: "tool", text: `${event.name} ${event.args.slice(0, 60)}` })
      }
      if (event.type === "tool_end") {
        const last = transcript[transcript.length - 1]
        if (last?.kind === "tool") {
          const firstLine = event.result.split(String.fromCharCode(10))[0] ?? ""
          last.text += `  →  ${firstLine.slice(0, 50)}`
        }
      }
      render()
    }
  } catch (error) {
    status = error instanceof Error ? error.message.slice(0, 120) : "request failed"
  } finally {
    streaming = false
    session.messages = messages
    void sessions.save(session).catch(() => {})
    render()
  }
}

function shutdown() {
  out.write(ansi.showCursor + ansi.mainScreen)
  process.exit(0)
}

out.write(ansi.altScreen + ansi.hideCursor)
render()
out.on("resize", render)

process.stdin.setRawMode?.(true)
process.stdin.resume()
process.stdin.on("data", (chunk) => {
  let dirty = false

  for (const key of parseKeys(chunk.toString())) {
    if (key.type === "ctrl" && key.value === "c") return shutdown()

    if (streaming) {
      // Only interruption is meaningful mid-turn.
      if (key.type === "escape") return shutdown()
      continue
    }

    switch (key.type) {
      case "escape":
        return shutdown()

      case "enter": {
        const text = input.trim()
        if (text) {
          history.push(text)
          historyIndex = -1
        }
        cursor = 0
        void send()
        return
      }

      case "backspace":
        if (cursor > 0) {
          input = input.slice(0, cursor - 1) + input.slice(cursor)
          cursor--
          dirty = true
        }
        break

      case "delete":
        if (cursor < input.length) {
          input = input.slice(0, cursor) + input.slice(cursor + 1)
          dirty = true
        }
        break

      case "left":
        if (cursor > 0) { cursor--; dirty = true }
        break

      case "right":
        if (cursor < input.length) { cursor++; dirty = true }
        break

      case "home":
        cursor = 0
        dirty = true
        break

      case "end":
        cursor = input.length
        dirty = true
        break

      // Up and down walk the prompt history, the way a shell does.
      case "up":
        if (history.length) {
          historyIndex = historyIndex < 0 ? history.length - 1 : Math.max(0, historyIndex - 1)
          input = history[historyIndex] ?? ""
          cursor = input.length
          dirty = true
        }
        break

      case "down":
        if (historyIndex >= 0) {
          historyIndex++
          if (historyIndex >= history.length) { historyIndex = -1; input = "" }
          else input = history[historyIndex] ?? ""
          cursor = input.length
          dirty = true
        }
        break

      case "pageup":
        scroll += 5
        dirty = true
        break

      case "pagedown":
        scroll = Math.max(0, scroll - 5)
        dirty = true
        break

      case "ctrl":
        if (key.value === "u") { input = ""; cursor = 0; dirty = true }
        if (key.value === "a") { cursor = 0; dirty = true }
        if (key.value === "e") { cursor = input.length; dirty = true }
        if (key.value === "w") {
          const upto = input.slice(0, cursor).replace(/s*S+s*$/, "")
          input = upto + input.slice(cursor)
          cursor = upto.length
          dirty = true
        }
        break

      case "char":
        input = input.slice(0, cursor) + key.value + input.slice(cursor)
        cursor++
        dirty = true
        break
    }
  }

  if (dirty) render()
})

process.on("SIGINT", shutdown)
