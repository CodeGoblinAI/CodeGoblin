/**
 * CodeGoblin TUI.
 *
 *   bun run tui
 *   bun run tui -- --model zai/glm-5.3
 *
 * Raw ANSI, no framework.
 */
import { ansi, theme, dim } from "./ansi"
import { WORDMARK, WORDMARK_WIDTH, COMPACT } from "./wordmark"
import { parseKeys } from "./keys"
import { displayWidth, truncateToWidth, padToWidth } from "./width"
import { renderMarkdown } from "./markdown"
import { paletteFor, renderPalette, type PaletteItem } from "./palette"
import { defaultSelection, resolveSelection, type Selection } from "../core/providers"
import { apiKey } from "../core/auth"
import { runAgent, type Message } from "../core/agent"
import { isCommand, runCommand } from "../core/commands"
import * as sessions from "../core/sessions"
import { usage, shouldCompact, planCompaction, applyCompaction } from "../core/context"
import { Permissions, type Decision } from "../core/permission"

const argv = process.argv.slice(2)
const flag = (name: string) => {
  const index = argv.indexOf(name)
  return index === -1 ? undefined : argv[index + 1]
}

let selection: Selection = resolveSelection(flag("--model") ?? flag("--provider")) ?? defaultSelection()
let key = apiKey(selection.provider.id)

const out = process.stdout
const SYSTEM: Message = {
  role: "system",
  content:
    "You are CodeGoblin, a coding agent. You have tools to read, list, write and edit files " +
    "in the working directory. Prefer reading before editing. Be concise.",
}

let messages: Message[] = [SYSTEM]
type Entry = { kind: "user" | "agent" | "tool" | "thinking"; text: string }
let transcript: Entry[] = []
let session = sessions.create(selection.provider.id)

let input = ""
let cursor = 0
let scroll = 0
const history: string[] = []
let historyIndex = -1
let streaming = false
let status = key ? "" : "no key for " + selection.provider.label

let pending: { tool: string; detail: string; resolve: (d: Decision) => void } | undefined
const permissions = new Permissions(
  (tool, detail) =>
    new Promise<Decision>((resolve) => {
      pending = { tool, detail, resolve }
      render()
    }),
)

let palette: PaletteItem[] | undefined
let paletteIndex = 0

let caretOn = true
const blink = setInterval(() => {
  if (streaming) return
  caretOn = !caretOn
  render()
}, 530)
blink.unref?.()

const size = () => ({ cols: out.columns ?? 80, rows: out.rows ?? 24 })
const charWidthOf = (char: string) => displayWidth(char)
const centre = (text: string, width: number) => " ".repeat(Math.max(0, Math.floor(width))) + text

function refreshPalette() {
  palette = paletteFor(input)
  if (!palette) paletteIndex = 0
  else paletteIndex = Math.min(paletteIndex, palette.length - 1)
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
        for (const [i, line] of entry.text.split(String.fromCharCode(10)).entries()) {
          lines.push(theme.muted + (i === 0 ? "  x " : "    ") + line.slice(0, width) + ansi.reset)
        }
        lines.push("")
        continue
      }
      if (entry.kind === "thinking") {
        lines.push(dim + "  thinking" + ansi.reset)
        for (const line of entry.text.split(String.fromCharCode(10)).slice(-6)) {
          lines.push(dim + "  | " + line.slice(0, width) + ansi.reset)
        }
        lines.push("")
        continue
      }
      const isUser = entry.kind === "user"
      const accent = isUser ? theme.gold : theme.goblin
      lines.push(accent + "  " + (isUser ? "you" : selection.provider.label.toLowerCase()) + ansi.reset)
      const rendered = isUser
        ? entry.text.split(String.fromCharCode(10)).map((l) => theme.text + l + ansi.reset)
        : renderMarkdown(entry.text, width)
      for (const line of rendered) lines.push(accent + "  | " + ansi.reset + line)
      lines.push("")
    }
  }

  const paletteLines = palette && !streaming ? renderPalette(palette, paletteIndex, cols) : []
  const composerHeight = 4 + paletteLines.length
  const room = Math.max(1, rows - composerHeight - 1)

  const maxScroll = Math.max(0, lines.length - room)
  scroll = Math.min(scroll, maxScroll)
  const cut = lines.length - room - scroll
  const body = lines.length > room ? lines.slice(Math.max(0, cut), Math.max(0, cut) + room) : lines
  while (body.length < room) body.push("")

  for (const line of paletteLines) body.push(line)

  const inner = Math.max(10, cols - 4)
  const visibleInput = Math.max(10, inner - 4)
  const caret = caretOn ? "\u2588" : " "
  let shown: string
  if (pending) {
    shown =
      theme.gold + "allow " + pending.tool + "? " + ansi.reset +
      theme.text + pending.detail.slice(0, Math.max(10, visibleInput - 24)) + ansi.reset +
      theme.muted + "  [y/n]" + ansi.reset
  } else if (streaming) {
    shown = dim + "goblin is working... ctrl+c to quit" + ansi.reset
  } else if (!input) {
    shown = theme.text + caret + ansi.reset + dim + "ask the goblin anything..." + ansi.reset
  } else {
    // Walk back from the cursor until the slice fills the visible width.
    let from = cursor
    let used = 0
    while (from > 0 && used + charWidthOf(input[from - 1]!) <= visibleInput - 1) {
      from--
      used += charWidthOf(input[from]!)
    }
    const slice = truncateToWidth(input.slice(from), visibleInput)
    const at = cursor - from
    shown =
      (from > 0 ? theme.muted + "..." + ansi.reset : "") +
      theme.text + slice.slice(0, at) + caret + slice.slice(at) + ansi.reset +
      (from + visibleInput < input.length ? theme.muted + "..." + ansi.reset : "")
  }

  body.push(theme.border + "  " + "-".repeat(inner) + ansi.reset)
  body.push(theme.goblin + "  | " + ansi.reset + shown)
  body.push(theme.border + "  " + "-".repeat(inner) + ansi.reset)

  const context = usage(messages, selection.model.contextWindow)
  const left =
    status || selection.provider.label + " . " + selection.model.id + "  " + context.percent + "% ctx"
  const right = scroll > 0 ? "scrolled " + scroll : palette ? "tab complete . up/down pick" : "/ commands . ctrl+c quit"
  const plain = "  " + left
  const padded = padToWidth(plain, Math.max(displayWidth(plain) + 1, cols - displayWidth(right) - 2))
  body.push(dim + padded + ansi.reset + theme.muted + right + ansi.reset)

  // Clamp on display width: CJK and emoji are two columns, so a line that
  // looks short by .length can still overflow and wrap.
  const clamped = body.map((line) => (displayWidth(line) <= cols ? line : truncateToWidth(line, cols - 1) + ansi.reset))

  out.write(ansi.clear + clamped.join(String.fromCharCode(10)))
}

async function send() {
  const text = input.trim()
  if (!text || streaming) return

  if (isCommand(text)) {
    input = ""
    cursor = 0
    palette = undefined
    const result = runCommand(text)
    if (result.kind === "quit") return shutdown()
    if (result.kind === "clear") {
      transcript = []
      messages = [SYSTEM]
      session = sessions.create(selection.provider.id)
      permissions.reset()
      status = "new conversation"
    }
    if (result.kind === "message") transcript.push({ kind: "tool", text: result.text })
    if (result.kind === "provider") {
      const next = resolveSelection(result.id)
      if (next) {
        selection = next
        key = apiKey(selection.provider.id)
        status = selection.provider.label + " " + selection.model.label
      }
    }
    if (result.kind === "compact") {
      const window = selection.model.contextWindow
      const plan = planCompaction(messages, window)
      if (!plan.summarise.length) status = "nothing to compact yet"
      else {
        const summary = plan.summarise
          .filter((m) => m.role === "user")
          .map((m) => "- " + m.content.slice(0, 160))
          .join(String.fromCharCode(10))
        messages = applyCompaction(plan.system, summary, plan.keep)
        status = "compacted to " + messages.length + " messages"
      }
    }
    if (result.kind === "sessions") {
      const saved = await sessions.list(10)
      transcript.push({
        kind: "tool",
        text: saved.length
          ? saved.map((entry) => entry.id + "  " + entry.title).join(String.fromCharCode(10))
          : "no saved sessions yet",
      })
    }
    render()
    return
  }

  if (!key) { status = "no key for " + selection.provider.label; render(); return }

  input = ""
  cursor = 0
  palette = undefined
  scroll = 0
  history.push(text)
  historyIndex = -1
  messages.push({ role: "user", content: text })
  transcript.push({ kind: "user", text })
  streaming = true
  status = ""
  render()

  let current: Entry | undefined
  try {
    for await (const event of runAgent({
      provider: selection.provider,
      modelId: selection.model.id,
      apiKey: key,
      messages,
      root: process.cwd(),
      contextWindow: selection.model.contextWindow,
      permissions,
    })) {
      if (event.type === "thinking") {
        if (!current || current.kind !== "thinking") {
          current = { kind: "thinking", text: "" }
          transcript.push(current)
        }
        current.text += event.delta
      }
      if (event.type === "text") {
        if (!current || current.kind !== "agent") {
          current = { kind: "agent", text: "" }
          transcript.push(current)
        }
        current.text += event.delta
      }
      if (event.type === "tool_start") {
        current = undefined
        transcript.push({ kind: "tool", text: event.name + " " + event.args.slice(0, 60) })
      }
      if (event.type === "compacted") {
        transcript.push({ kind: "tool", text: "compacted context: " + event.before + " -> " + event.after + " messages" })
      }
      if (event.type === "tool_denied") {
        const last = transcript[transcript.length - 1]
        if (last && last.kind === "tool") last.text += "  (refused)"
      }
      if (event.type === "tool_end") {
        const last = transcript[transcript.length - 1]
        if (last && last.kind === "tool") {
          const firstLine = event.result.split(String.fromCharCode(10))[0] ?? ""
          last.text += "  ->  " + firstLine.slice(0, 50)
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

  for (const pressed of parseKeys(chunk.toString())) {
    if (pressed.type === "ctrl" && pressed.value === "c") return shutdown()

    if (pending) {
      if (pressed.type === "char" && /^[yn]$/i.test(pressed.value)) {
        const answer = pressed.value.toLowerCase() === "y" ? "allow" : "deny"
        const ask = pending
        pending = undefined
        ask.resolve(answer)
        render()
      }
      // Anything else is ignored: a stray key must not answer for the user.
      continue
    }

    if (streaming) {
      // Nothing to do mid-turn; quitting is ctrl+c only.
      continue
    }

    // While the palette is open it owns up, down, tab and escape.
    if (palette) {
      if (pressed.type === "up") { paletteIndex = Math.max(0, paletteIndex - 1); dirty = true; continue }
      if (pressed.type === "down") { paletteIndex = Math.min(palette.length - 1, paletteIndex + 1); dirty = true; continue }
      if (pressed.type === "escape") { palette = undefined; render(); continue }
      if (pressed.type === "enter") {
        const chosen = palette[paletteIndex]!.value
        // Enter on an item already in the input means "yes, that one" - send
        // it. Otherwise fill it in first, so a choice is always confirmed.
        if (input.trim() === chosen) { palette = undefined; void send(); return }
        const needsArgument = chosen === "/model"
        input = needsArgument ? chosen + " " : chosen
        cursor = input.length
        refreshPalette()
        render()
        continue
      }
      if (pressed.type === "ctrl" && pressed.value === "i") {
        input = palette[paletteIndex]!.value + " "
        cursor = input.length
        refreshPalette()
        dirty = true
        continue
      }
    }

    switch (pressed.type) {
      // Escape clears the line; it never exits. Quitting is ctrl+c.
      case "escape":
        if (input) { input = ""; cursor = 0; dirty = true }
        break
      case "enter": void send(); return
      case "backspace":
        if (cursor > 0) { input = input.slice(0, cursor - 1) + input.slice(cursor); cursor--; dirty = true }
        break
      case "delete":
        if (cursor < input.length) { input = input.slice(0, cursor) + input.slice(cursor + 1); dirty = true }
        break
      case "left": if (cursor > 0) { cursor--; dirty = true } break
      case "right": if (cursor < input.length) { cursor++; dirty = true } break
      case "home": cursor = 0; dirty = true; break
      case "end": cursor = input.length; dirty = true; break
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
      case "pageup": scroll += 5; dirty = true; break
      case "pagedown": scroll = Math.max(0, scroll - 5); dirty = true; break
      case "ctrl":
        if (pressed.value === "u") { input = ""; cursor = 0; dirty = true }
        if (pressed.value === "a") { cursor = 0; dirty = true }
        if (pressed.value === "e") { cursor = input.length; dirty = true }
        break
      case "char":
        input = input.slice(0, cursor) + pressed.value + input.slice(cursor)
        cursor++
        dirty = true
        break
    }
  }

  if (dirty) { refreshPalette(); caretOn = true; render() }
})

process.on("SIGINT", shutdown)
