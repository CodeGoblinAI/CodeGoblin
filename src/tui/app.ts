/**
 * CodeGoblin TUI.
 *
 *   bun run tui
 *   bun run tui -- --model zai/glm-5.3
 *
 * Raw ANSI, no framework.
 */
import { ansi, theme, dim, applyTheme } from "./ansi"
import { WORDMARK, WORDMARK_WIDTH, COMPACT } from "./wordmark"
import { parseKeys } from "./keys"
import { displayWidth, truncateToWidth, padToWidth } from "./width"
import { renderMarkdown } from "./markdown"
import { paletteFor, renderPalette, setSessionCache, setFileCache, type PaletteItem } from "./palette"
import { findMention, expandMentions } from "../core/mention"
import { History, describe as describeCheckpoint, nothingToDo } from "../core/undo"
import * as settingsStore from "../core/settings"
import { exportSession } from "../core/export"
import { runMedia, describeMedia, type MediaKind } from "../core/media"
import * as memory from "../core/memory"
import { globFiles } from "../core/search"
import { defaultSelection, resolveSelection, type Selection, kindOf } from "../core/providers"
import { apiKey } from "../core/auth"
import { runAgent, type Message } from "../core/agent"
import { isCommand, runCommand } from "../core/commands"
import * as sessions from "../core/sessions"
import { usage, shouldCompact, planCompaction, applyCompaction } from "../core/context"
import { marker, counts, type Todo } from "../core/todo"
import { Permissions, DECISIONS, type Decision } from "../core/permission"

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
/** Named for what it holds, since "history" here is the prompt recall list. */
const edits = new History()
let settings = settingsStore.defaults()
let session = sessions.create(selection.provider.id)

let input = ""
let cursor = 0
let scroll = 0
const history: string[] = []
let historyIndex = -1
let streaming = false
let status = key ? "" : "no key for " + selection.provider.label

let pending: { tool: string; detail: string; resolve: (d: Decision) => void } | undefined
/** Which answer is highlighted. Starts on "allow once", the least committal. */
let pendingChoice = 0

/**
 * A panel you read and dismiss.
 *
 * /status used to print into the transcript, where it stayed forever and
 * pushed the conversation up. It is a glance, not a message.
 */
let overlay: { title: string; rows: [string, string][] } | undefined
const permissions = new Permissions(
  (tool, detail) =>
    new Promise<Decision>((resolve) => {
      pending = { tool, detail, resolve }
      pendingChoice = 0
      render()
    }),
)

// The plan sits above the composer rather than scrolling away in the
// transcript, because it is the thing you keep glancing at.
let plan: Todo[] = []

let palette: PaletteItem[] | undefined
let paletteIndex = 0

/**
 * Where the caret sits on screen, so the terminal can draw its own.
 *
 * This used to be a block character toggled by a timer, which meant a full
 * repaint twice a second - and a repaint discards whatever the user has
 * selected, so text could never stay highlighted long enough to copy. The
 * terminal already has a cursor, and it blinks for free.
 */
let caretAt: { row: number; col: number } | undefined

const size = () => ({ cols: out.columns ?? 80, rows: out.rows ?? 24 })
const charWidthOf = (char: string) => displayWidth(char)
const centre = (text: string, width: number) => " ".repeat(Math.max(0, Math.floor(width))) + text

let paletteSignature = ""

/**
 * Put a completion where the caret is.
 *
 * A slash command replaces the whole line, because there is only ever one of
 * them. A file mention replaces just its own token: it is part of a sentence,
 * and the rest of what was typed has to survive being completed.
 */
function completeWith(value: string) {
  if (value.startsWith("@")) {
    const mention = findMention(input, cursor)
    if (mention) {
      input = input.slice(0, mention.start) + value + " " + input.slice(mention.end)
      cursor = mention.start + value.length + 1
      return
    }
  }
  input = value + " "
  cursor = input.length
}

function refreshPalette() {
  palette = paletteFor(input, cursor)
  // Reset the highlight whenever the list itself changes: carrying an index
  // across two different lists selects something the user never looked at.
  const signature = (palette ?? []).map((item) => item.value).join("|")
  if (signature !== paletteSignature) {
    paletteSignature = signature
    paletteIndex = 0
    return
  }
  if (palette) paletteIndex = Math.min(paletteIndex, palette.length - 1)
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
        // Hiding reasoning is a view, not a filter on what is collected -
        // turning it back on should show what was said while it was off.
        if (!settings.thinking) continue
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

  const planLines: string[] = []
  if (plan.length) {
    const { done, total } = counts(plan)
    planLines.push(theme.gold + "  plan " + done + "/" + total + ansi.reset)
    for (const todo of plan.slice(0, 8)) {
      const done = todo.status === "completed"
      const active = todo.status === "in_progress"
      const colour = done ? theme.muted : active ? theme.goblin : theme.text
      const text = truncateToWidth(todo.content, Math.max(10, cols - 12))
      planLines.push(colour + "  [" + marker(todo.status) + "] " + text + ansi.reset)
    }
    if (plan.length > 8) planLines.push(theme.muted + "  … " + (plan.length - 8) + " more" + ansi.reset)
    planLines.push("")
  }

  const paletteLines = palette && !streaming ? renderPalette(palette, paletteIndex, cols) : []
  const composerHeight = 4 + paletteLines.length + planLines.length
  const room = Math.max(1, rows - composerHeight - 1)

  const maxScroll = Math.max(0, lines.length - room)
  scroll = Math.min(scroll, maxScroll)
  const cut = lines.length - room - scroll
  const body = lines.length > room ? lines.slice(Math.max(0, cut), Math.max(0, cut) + room) : lines
  while (body.length < room) body.push("")

  for (const line of planLines) body.push(line)
  for (const line of paletteLines) body.push(line)

  if (overlay) {
    const labelWidth = Math.max(...overlay.rows.map(([label]) => displayWidth(label))) + 2
    const valueWidth = Math.min(
      Math.max(...overlay.rows.map(([, value]) => displayWidth(value))),
      Math.max(20, cols - labelWidth - 12),
    )
    const inner = labelWidth + valueWidth + 4
    body.push(theme.border + "  ╭" + "─".repeat(inner) + "╮" + ansi.reset)
    body.push(
      theme.border + "  │" + ansi.reset +
        theme.gold + padToWidth("  " + overlay.title, inner) + ansi.reset +
        theme.border + "│" + ansi.reset,
    )
    for (const [label, value] of overlay.rows) {
      const row =
        "  " + theme.muted + padToWidth(label, labelWidth) + ansi.reset +
        theme.text + truncateToWidth(value, valueWidth) + ansi.reset
      body.push(
        theme.border + "  │" + ansi.reset + padToWidth(row, inner) + theme.border + "│" + ansi.reset,
      )
    }
    body.push(theme.border + "  ╰" + "─".repeat(inner) + "╯" + ansi.reset)
  }

  // Consent is a list you move through, not a letter you have to know. It
  // sits where the palette does, so the answer is next to the question.
  if (pending) {
    // One width for every row, padded after colouring - displayWidth skips
    // escape sequences, so the box lines up whatever colour the text is.
    const labelWidth = Math.max(...DECISIONS.map((d) => displayWidth(d.label))) + 2
    const hintWidth = Math.max(...DECISIONS.map((d) => displayWidth(d.hint)))
    const inner = 3 + labelWidth + hintWidth + 1

    body.push(theme.border + "  " + "╭" + "─".repeat(inner) + "╮" + ansi.reset)
    body.push(
      theme.border + "  │" + ansi.reset +
        theme.gold + padToWidth(" allow this?", inner) + ansi.reset +
        theme.border + "│" + ansi.reset,
    )
    for (const [index, choice] of DECISIONS.entries()) {
      const active = index === pendingChoice
      const marker = active ? theme.goblin + " ❯ " + ansi.reset : "   "
      const label = (active ? theme.text : theme.muted) + padToWidth(choice.label, labelWidth) + ansi.reset
      const row = marker + label + dim + choice.hint + ansi.reset
      body.push(
        theme.border + "  │" + ansi.reset + padToWidth(row, inner) + theme.border + "│" + ansi.reset,
      )
    }
    body.push(theme.border + "  " + "╰" + "─".repeat(inner) + "╯" + ansi.reset)
  }

  const inner = Math.max(10, cols - 4)
  const visibleInput = Math.max(10, inner - 4)
  /** Columns from the start of the composer content to the caret. */
  let caretOffset: number | undefined
  let shown: string
  if (pending) {
    shown =
      theme.gold + pending.tool + ansi.reset + " " +
      dim + pending.detail.slice(0, Math.max(10, visibleInput - 24)) + ansi.reset
  } else if (streaming) {
    shown = dim + "goblin is working... ctrl+c to quit" + ansi.reset
  } else if (!input) {
    caretOffset = 0
    shown = dim + "ask the goblin anything..." + ansi.reset
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
    caretOffset = (from > 0 ? 3 : 0) + displayWidth(slice.slice(0, at))
    shown =
      (from > 0 ? theme.muted + "..." + ansi.reset : "") +
      theme.text + slice + ansi.reset +
      (from + visibleInput < input.length ? theme.muted + "..." + ansi.reset : "")
  }

  body.push(theme.border + "  " + "-".repeat(inner) + ansi.reset)
  body.push(theme.goblin + "  | " + ansi.reset + shown)
  body.push(theme.border + "  " + "-".repeat(inner) + ansi.reset)

  const context = usage(messages, selection.model.contextWindow)
  const left =
    status || selection.provider.label + " . " + selection.model.id + "  " + context.percent + "% ctx"
  const right = overlay
    ? "any key closes"
    : pending
    ? "up/down choose . enter confirm . esc reject"
    : scroll > 0
      ? "scrolled " + scroll
      : palette
        ? "tab complete . up/down pick"
        : "/ commands . @ files . ctrl+c quit"
  const plain = "  " + left
  const padded = padToWidth(plain, Math.max(displayWidth(plain) + 1, cols - displayWidth(right) - 2))
  body.push(dim + padded + ansi.reset + theme.muted + right + ansi.reset)

  // Clamp on display width: CJK and emoji are two columns, so a line that
  // looks short by .length can still overflow and wrap.
  const clamped = body.map((line) => (displayWidth(line) <= cols ? line : truncateToWidth(line, cols - 1) + ansi.reset))

  // The composer is the third line from the bottom: rule, input, rule, status.
  caretAt = caretOffset === undefined ? undefined : { row: body.length - 2, col: 5 + caretOffset }

  out.write(
    ansi.hideCursor + ansi.clear + clamped.join(String.fromCharCode(10)) +
      (caretAt ? ansi.moveTo(caretAt.row, caretAt.col) + ansi.showCursor : ""),
  )
}

/**
 * Run a generator and put the result in the transcript.
 *
 * The selected model is passed through, which is the whole mechanism: there
 * is one list of models, and the one you picked decides what a prompt turns
 * into. Without this /image fell back to a default provider and choosing
 * Tripo changed nothing at all.
 */
async function generate(kind: MediaKind, line: string) {
  streaming = true
  status = "generating..."
  transcript.push({ kind: "user", text: line })
  render()
  const generated = await runMedia(kind, line, process.cwd(), {
    provider: selection.provider.id,
    model: selection.model.id,
  })
  streaming = false
  transcript.push({ kind: "tool", text: describeMedia(generated) })
  status = generated.ok ? "" : "generation failed"
  render()
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
      plan = []
      session = sessions.create(selection.provider.id)
      permissions.reset()
      edits.reset()
      overlay = undefined
      status = "new conversation"
    }
    if (result.kind === "message") transcript.push({ kind: "tool", text: result.text })
    if (result.kind === "theme") {
      settings = { ...settings, theme: result.name }
      applyTheme(result.name)
      void settingsStore.save(settings)
      status = "theme: " + result.name
    }
    if (result.kind === "thinking") {
      settings = { ...settings, thinking: !settings.thinking }
      void settingsStore.save(settings)
      status = settings.thinking ? "showing the model's reasoning" : "hiding the model's reasoning"
    }
    if (result.kind === "rename") {
      session.title = result.title.slice(0, 80)
      void sessions.save(session).then(refreshSessionCache).catch(() => {})
      status = "renamed to " + session.title
      transcript.push({ kind: "tool", text: "renamed this conversation to " + session.title })
    }
    if (result.kind === "export") {
      session.messages = messages
      try {
        const name = await exportSession(session, process.cwd(), Date.now(), result.path)
        status = "wrote " + name
      } catch (error) {
        status = "export failed: " + (error instanceof Error ? error.message.slice(0, 80) : "unknown")
      }
    }
    if (result.kind === "media") {
      await generate(result.media, result.line)
      return
    }
    if (result.kind === "memory") {
      try {
        if (result.action === "add") {
          const entry = await memory.add({ scope: "project", content: result.text!, project: process.cwd() })
          transcript.push({ kind: "tool", text: "remembered: " + entry.content })
          status = "remembered"
        } else if (result.action === "forget") {
          const gone = await memory.remove(result.text!)
          status = gone ? "forgotten" : "no memory with that id"
        } else if (result.action === "clear") {
          const count = await memory.clear()
          status = count ? "forgot " + count + (count === 1 ? " memory" : " memories") : "nothing to forget"
        } else {
          const entries = await memory.list({ project: process.cwd(), query: result.text })
          overlay = entries.length
            ? { title: result.text ? "memory matching " + result.text : "memory", rows: entries.map((entry) => [entry.id, (entry.pinned ? "* " : "") + entry.content] as [string, string]) }
            : { title: "memory", rows: [["", result.text ? "nothing matches" : "nothing remembered yet"]] }
        }
      } catch (error) {
        status = error instanceof Error ? error.message.slice(0, 90) : "memory failed"
      }
    }
    if (result.kind === "status") {
      const context = usage(messages, selection.model.contextWindow)
      const approved = permissions.summary()
      const rows: [string, string][] = [
        ["model", selection.provider.label + " " + selection.model.label],
        ["session", session.title + "  (" + messages.length + " messages)"],
        ["context", context.percent + "% of " + selection.model.contextWindow.toLocaleString()],
        ["theme", settings.theme],
        ["thinking", settings.thinking ? "shown" : "hidden"],
        ["approved", approved.length ? approved.join(", ") : "nothing yet"],
        ["undo", edits.canUndo() ? "available" : "nothing to take back"],
        ["working in", process.cwd()],
      ]
      overlay = { title: "status", rows }
    }
    if (result.kind === "undo" || result.kind === "redo") {
      const forward = result.kind === "redo"
      try {
        const checkpoint = forward ? await edits.redo(process.cwd()) : await edits.undo(process.cwd())
        status = checkpoint
          ? (forward ? "redid " : "undid ") + describeCheckpoint(checkpoint)
          : nothingToDo(edits, forward)
      } catch (error) {
        status = "undo failed: " + (error instanceof Error ? error.message.slice(0, 90) : "unknown")
      }
    }
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
    if (result.kind === "resume") {
      await refreshSessionCache()
      if (!result.id) {
        const saved = await sessions.list(10)
        transcript.push({
          kind: "tool",
          text: saved.length
            ? "type /resume and a space to pick one:" + String.fromCharCode(10) +
              saved.map((entry) => entry.id + "  " + entry.title).join(String.fromCharCode(10))
            : "no saved conversations yet",
        })
      } else {
        const loaded = await sessions.load(result.id)
        if (!loaded) status = "no such conversation: " + result.id
        else {
          session = loaded
          messages = loaded.messages
          // Rebuild what the user sees from what the model was told.
          transcript = []
          for (const message of messages) {
            if (message.role === "user") transcript.push({ kind: "user", text: message.content })
            else if (message.role === "assistant" && message.content) transcript.push({ kind: "agent", text: message.content })
          }
          status = "resumed: " + loaded.title
        }
      }
    }
    render()
    return
  }

  // A generation model has no chat endpoint, so a plain prompt belongs to it
  // rather than to a conversation. Picking one and typing is how you make a
  // picture without remembering a command.
  const selectedKind = kindOf(selection.model)
  if (selectedKind !== "text") {
    input = ""
    cursor = 0
    palette = undefined
    history.push(text)
    historyIndex = -1
    await generate(selectedKind, text)
    return
  }

  if (!key) { status = "no key for " + selection.provider.label; render(); return }

  input = ""
  cursor = 0
  palette = undefined
  scroll = 0
  history.push(text)
  historyIndex = -1
  // Mentions are read here rather than in the agent so the stored message
  // carries the files with it: a resumed conversation keeps its context.
  const mentioned = await expandMentions(text, process.cwd())
  messages.push(
    mentioned.files.length ? { role: "user", content: mentioned.content, display: text } : { role: "user", content: text },
  )
  transcript.push({ kind: "user", text })
  if (mentioned.files.length) transcript.push({ kind: "tool", text: "attached " + mentioned.files.join(", ") })
  streaming = true
  status = ""
  render()

  let current: Entry | undefined
  // Everything this turn writes is captured under one checkpoint, so /undo
  // takes back the whole answer rather than its last file.
  edits.begin(text)
  try {
    for await (const event of runAgent({
      provider: selection.provider,
      modelId: selection.model.id,
      apiKey: key,
      messages,
      root: process.cwd(),
      contextWindow: selection.model.contextWindow,
      permissions,
      history: edits,
      memory: await memory.recall({ project: process.cwd(), session: session.id }),
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
      if (event.type === "plan") {
        plan = event.todos
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
    edits.commit()
    session.messages = messages
    void sessions.save(session).then(refreshSessionCache).catch(() => {})
    render()
  }
}

function shutdown() {
  out.write(ansi.showCursor + ansi.mainScreen)
  process.exit(0)
}

async function refreshSessionCache() {
  setSessionCache((await sessions.list(30)).map(({ id, title }) => ({ id, title })))
}
void refreshSessionCache()

async function refreshFileCache() {
  setFileCache(await globFiles(process.cwd(), "**/*", 4000).catch(() => []))
}
void refreshFileCache()

async function loadSettings() {
  settings = await settingsStore.load()
  applyTheme(settings.theme)
  render()
}
void loadSettings()

out.write(ansi.altScreen)
render()
out.on("resize", render)

process.stdin.setRawMode?.(true)
process.stdin.resume()
process.stdin.on("data", (chunk) => {
  let dirty = false

  for (const pressed of parseKeys(chunk.toString())) {
    if (pressed.type === "ctrl" && pressed.value === "c") return shutdown()

    if (overlay) {
      // Anything at all closes it: it is a panel to read, not one to operate.
      overlay = undefined
      if (pressed.type === "escape" || pressed.type === "enter") { render(); continue }
      // A keystroke meant for the composer still lands there, so dismissing
      // it does not cost the character someone was already typing.
    }

    if (pending) {
      const answer = (decision: Decision) => {
        const ask = pending!
        pending = undefined
        ask.resolve(decision)
        render()
      }
      if (pressed.type === "up") { pendingChoice = Math.max(0, pendingChoice - 1); render(); continue }
      if (pressed.type === "down") { pendingChoice = Math.min(DECISIONS.length - 1, pendingChoice + 1); render(); continue }
      if (pressed.type === "enter") { answer(DECISIONS[pendingChoice]!.id); continue }
      if (pressed.type === "escape") { answer("reject"); continue }
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

        // A file mention is part of a question, not the whole of one. Picking
        // it drops the path in and leaves the composer open to ask about it.
        if (chosen.startsWith("@")) {
          completeWith(chosen)
          refreshPalette()
          render()
          continue
        }

        // A bare command that takes an argument expands rather than runs:
        // typing /model and pressing enter should offer the models, not print
        // help. An item containing a space is already a complete choice, so it
        // must not expand again - that was why picking a model did nothing.
        const isBareCommand = !chosen.includes(" ")
        const expanded = isBareCommand ? paletteFor(chosen + " ") : undefined
        if (expanded) {
          input = chosen + " "
          cursor = input.length
          refreshPalette()
          render()
          continue
        }

        // Anything else is a complete choice - picking it from a list is the
        // confirmation, so run it rather than asking again.
        input = chosen
        cursor = input.length
        palette = undefined
        void send()
        return
      }
      if (pressed.type === "ctrl" && pressed.value === "i") {
        completeWith(palette[paletteIndex]!.value)
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
        if (cursor > 0) { input = input.slice(0, cursor - 1) + input.slice(cursor); cursor--; dirty = true; refreshPalette() }
        break
      case "delete":
        if (cursor < input.length) { input = input.slice(0, cursor) + input.slice(cursor + 1); dirty = true; refreshPalette() }
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
        if (pressed.value === "u") { input = ""; cursor = 0; dirty = true; refreshPalette() }
        if (pressed.value === "a") { cursor = 0; dirty = true }
        if (pressed.value === "e") { cursor = input.length; dirty = true }
        break
      case "char":
        input = input.slice(0, cursor) + pressed.value + input.slice(cursor)
        cursor++
        dirty = true
        refreshPalette()
        break
    }
  }

  if (dirty) { refreshPalette(); render() }
})

process.on("SIGINT", shutdown)
