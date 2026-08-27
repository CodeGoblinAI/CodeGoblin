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
import { WORDMARK, WORDMARK_WIDTH, COMPACT } from "./wordmark"
import { PROVIDERS, DEFAULT_PROVIDER } from "../core/providers"
import { apiKey } from "../core/auth"
import { streamChat, type Message } from "../core/chat"

const argv = process.argv.slice(2)
const providerId = argv[argv.indexOf("--provider") + 1] ?? DEFAULT_PROVIDER
const provider = PROVIDERS[providerId] ?? PROVIDERS[DEFAULT_PROVIDER]!
const key = apiKey(provider.id)

const out = process.stdout
const messages: Message[] = []
let input = ""
let streaming = false
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

  if (messages.length === 0) {
    const wide = cols >= WORDMARK_WIDTH + 4
    const art = wide ? WORDMARK : [COMPACT]
    const gutter = (cols - (wide ? WORDMARK_WIDTH : COMPACT.length)) / 2
    lines.push("")
    for (const row of art) lines.push(theme.goblin + centre(row, gutter) + ansi.reset)
    lines.push("")
    lines.push(theme.gold + centre("your local AI goblin for code, images and agents", (cols - 47) / 2) + ansi.reset)
  } else {
    for (const message of messages) {
      const isUser = message.role === "user"
      const accent = isUser ? theme.gold : theme.goblin
      lines.push(accent + "  " + (isUser ? "you" : provider.label.toLowerCase()) + ansi.reset)
      for (const line of wrap(message.content, width)) {
        lines.push(accent + "  │ " + ansi.reset + theme.text + line + ansi.reset)
      }
      lines.push("")
    }
  }

  // Keep the newest content visible.
  const composerHeight = 4
  const room = Math.max(1, rows - composerHeight - 1)
  const body = lines.length > room ? lines.slice(lines.length - room) : lines
  while (body.length < room) body.push("")

  const inner = Math.max(10, cols - 4)
  const shown = streaming
    ? `${dim}goblin is thinking… esc to quit${ansi.reset}`
    : input || `${dim}ask the goblin anything…${ansi.reset}`

  body.push(theme.border + "  " + "─".repeat(inner) + ansi.reset)
  body.push(theme.goblin + "  │ " + ansi.reset + theme.text + shown + ansi.reset)
  body.push(theme.border + "  " + "─".repeat(inner) + ansi.reset)

  const left = status || `${provider.label} · ${provider.model}`
  const right = "ctrl+c quit"
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

  input = ""
  messages.push({ role: "user", content: text })
  messages.push({ role: "assistant", content: "" })
  streaming = true
  status = ""
  render()

  const reply = messages[messages.length - 1]!
  try {
    for await (const delta of streamChat({ provider, apiKey: key, messages: messages.slice(0, -1) })) {
      reply.content += delta
      render()
    }
  } catch (error) {
    reply.content = ""
    status = error instanceof Error ? error.message.slice(0, 120) : "request failed"
  } finally {
    streaming = false
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
  // A chunk is not a keypress. Fast typing and paste deliver several
  // characters at once, so walk them rather than comparing the whole string.
  const text = chunk.toString()
  let dirty = false

  for (const char of text) {
    const code = char.charCodeAt(0)
    if (code === 3) return shutdown()                    // ctrl+c
    if (code === 27 && !streaming) return shutdown()     // esc
    if (streaming) continue
    if (code === 13 || code === 10) { void send(); return } // enter
    if (code === 127 || code === 8) { input = input.slice(0, -1); dirty = true; continue }
    if (code >= 32 && code <= 126) { input += char; dirty = true }
  }

  if (dirty) render()
})

process.on("SIGINT", shutdown)
