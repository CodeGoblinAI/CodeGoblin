/**
 * CodeGoblin TUI.
 *
 *   bun run tui
 *   bun run tui -- --model zai/glm-5.3
 *
 * Raw ANSI, no framework.
 */
import { ansi, theme, dim, invert, noInvert, applyTheme } from "./ansi"
import { WORDMARK, WORDMARK_WIDTH, COMPACT } from "./wordmark"
import { THEMES } from "../core/theme"
import { EFFORTS } from "../core/settings"
import { createKeyReader } from "./keys"
import { parseLaunch } from "./args"
import * as Dialogs from "./dialog"
import { changesIn, summarise, countsOf, statusLetter, type Changes } from "../core/changes"
import {
  ComposerHistory,
  deleteRange,
  insert as insertText,
  moveTo,
  selectAll,
  selection as composerSelection,
  wordEnd,
  wordStart,
  type Composer,
} from "./composer"
import { displayWidth, truncateToWidth, padToWidth } from "./width"
import { renderMarkdown } from "./markdown"
import {
  paletteFor,
  renderPalette,
  setFileCache,
  setConnectedProviders,
  type PaletteItem,
} from "./palette"
import { findMention, expandMentions } from "../core/mention"
import { History, describe as describeCheckpoint, nothingToDo } from "../core/undo"
import * as settingsStore from "../core/settings"
import {
  loadMedia,
  saveMedia,
  withValue,
  optionById,
  labelOf,
  optionsForModel,
  valueOf,
  DEFAULT as MEDIA_DEFAULT,
  type MediaSettings,
  type MediaChoice,
} from "../core/media-settings"
import { exportSession } from "../core/export"
import { runMedia, describeMedia, type MediaKind } from "../core/media"
import * as memory from "../core/memory"
import { globFiles } from "../core/search"
import { defaultSelection, resolveSelection, acceptsImages, effortFor, takesEffort, type Selection, kindOf } from "../core/providers"
import { apiKey, connect, disconnect, connections, storePath, envVariable } from "../core/auth"
import { runAgent, type Message } from "../core/agent"
import { isCommand, runCommand } from "../core/commands"
import * as sessions from "../core/sessions"
import {
  usage,
  shouldCompact,
  planCompaction,
  applyCompaction,
  addSpend,
  priceOf,
  formatSpend,
  type Spend,
} from "../core/context"
import { marker, counts, type Todo } from "../core/todo"
import { Permissions, DECISIONS, MODES, nextMode, commandOf, refusalLabel, type Decision } from "../core/permission"
import { McpManager } from "../core/mcp"
import { customCommands, invocationItems, resolveInvocation } from "../core/invocations"
import { listSkills, skillIndex } from "../core/skills"
import { setInvocations } from "./palette"
import { configPath } from "../core/config"

const argv = process.argv.slice(2)

/**
 * Work somewhere else.
 *
 * Every tool is confined to the working directory, which is the right rule
 * and the wrong default when the directory is fixed to wherever the app
 * happened to be launched. A first argument moves it, so
 *
 *   cg ../some-other-project
 *
 * opens there and the sandbox follows. The confinement is unchanged - it is
 * the same one rule, just pointed where you meant.
 */
const requested = parseLaunch(argv).directory
if (requested) {
  try {
    process.chdir(requested)
  } catch {
    process.stderr.write(`cannot open ${requested}` + String.fromCharCode(10))
    process.exit(1)
  }
}

let selection: Selection = resolveSelection(parseLaunch(argv).model) ?? defaultSelection()
let key = apiKey(selection.provider.id)

const out = process.stdout
/**
 * What the model is told before anything else.
 *
 * This was two sentences that named four tools and left out the other five,
 * said nothing about where it was running, and gave no guidance at all -
 * so the model guessed at paths, re-read files it had just written, and
 * asked permission for things it could simply do.
 */
const SYSTEM: Message = {
  role: "system",
  content: [
    "You are CodeGoblin, a coding agent working in a terminal.",
    "",
    "Tools: read_file, list_files, grep and glob to look around; write_file and",
    "edit_file to change things; shell to run commands; webfetch to read a page;",
    "todo_write to keep a plan the user can see; skill to load one of the skills listed below.",
    "",
    "Everything is confined to the working directory - paths outside it are",
    "refused, so use relative paths. Read a file before editing it, and prefer",
    "edit_file over write_file: it changes only what you name and fails loudly",
    "rather than silently rewriting the whole file.",
    "",
    "Use todo_write for anything that takes more than a couple of steps, and",
    "keep it updated as you go - it is how the user follows along.",
    "",
    "Writing, running commands and fetching pages ask the user for permission.",
    "A refusal is an answer: say what you would have done and stop, rather than",
    "trying another way around it.",
    "",
    "Be concise. Answer in prose, not headings, unless the answer really is a",
    "list. Do not narrate what you are about to do; do it, then say what",
    "happened.",
  ].join(String.fromCharCode(10)),
}

let messages: Message[] = [SYSTEM]
/**
 * `call` is the model's tool-call id on a tool row, so a result lands on the
 * row that asked for it. Rows used to be matched by being last, which stopped
 * being true once reads in a turn started overlapping.
 */
type Entry = { kind: "user" | "agent" | "tool" | "thinking"; text: string; call?: string }
let transcript: Entry[] = []
/** Named for what it holds, since "history" here is the prompt recall list. */
/**
 * The prompt, as an editor.
 *
 * input and cursor stay the source of truth so nothing else has to change;
 * anchor is the one new piece, and composer.ts holds all the actual rules so
 * they can be tested without a terminal.
 */
let anchor: number | undefined
const composerHistory = new ComposerHistory()

const composerState = (): Composer => ({ text: input, cursor, anchor })

function applyComposer(next: Composer, remember = false) {
  if (remember) composerHistory.remember(composerState())
  input = next.text
  cursor = next.cursor
  anchor = next.anchor
}
const edits = new History()

/**
 * MCP servers from codegoblin.jsonc, connected in the background so a slow one
 * never holds up the first screen. /mcp says how each is doing.
 */
const mcp = McpManager.fromConfig()
void mcp.start()

// Custom commands and skills join the slash picker. Read once here for the
// picker; a message reads them fresh, so one written mid-session still runs.
setInvocations(invocationItems(process.cwd()))

/**
 * Text that was pasted rather than typed.
 *
 * A long paste used to land in the composer whole, so the prompt became a
 * wall you could not read past or edit around. Each one is held here and
 * shown as a single line saying how much it was; the real text goes to the
 * model on submit, so nothing is lost - it just stops being in the way.
 */
type Pasted = { token: string; text: string; lines: number }
let pastes: Pasted[] = []

/** Long enough to be worth folding away; below this it just reads as typing. */
const PASTE_FOLD_LINES = 4

function foldPaste(text: string): string {
  const lines = text.split(String.fromCharCode(10)).length
  if (lines < PASTE_FOLD_LINES) return text
  const token = `[Pasted ~${lines} lines]`
  pastes.push({ token, text, lines })
  return token
}

/** Put the real text back, for the model rather than the screen. */
function unfoldPastes(text: string): string {
  let out = text
  for (const paste of pastes) out = out.split(paste.token).join(paste.text)
  return out
}
let settings = settingsStore.defaults()
/** How generation should come out. Separate file, separate lifetime. */
let media: MediaSettings = {}
/** The account's voices, once fetched, so a voice id can be shown by name. */
let voices: MediaChoice[] = []
let session = sessions.create(selection.provider.id)

let input = ""
let cursor = 0
let scroll = 0
const history: string[] = []
let historyIndex = -1
let streaming = false

/**
 * The running turn, so it can be stopped.
 *
 * There was no way to interrupt one at all: once a model started, the only
 * exit was killing the process, which loses the conversation with it.
 */
let turn: AbortController | undefined

/**
 * Something to say while the model is still talking.
 *
 * Watching an answer go the wrong way and being able to do nothing about it
 * but stop it is the worst version of this. Typing mid-turn is allowed, and
 * enter queues the message: it is sent the moment the turn ends, so a
 * correction can be written the moment it is noticed rather than remembered
 * until the model is finished.
 */
let queued: string | undefined

/**
 * What this session has cost.
 *
 * Providers report usage on the last chunk of each turn. An unpriced model
 * shows tokens instead of a number, because a spend of nothing and a spend
 * nobody has published are different things.
 */
let spend: Spend = { input: 0, output: 0 }

/**
 * Something moving while the model thinks.
 *
 * A still line reads as frozen, and these calls take real seconds. The
 * timer only runs while a turn does: the screen is already repainting on
 * every token then, so it costs nothing - and when idle nothing is written
 * at all, which is what keeps text selectable.
 */
const SPINNER = ["\u280b", "\u2819", "\u2839", "\u2838", "\u283c", "\u2834", "\u2826", "\u2827", "\u2807", "\u280f"]
let spinnerTick = 0
let spinnerTimer: ReturnType<typeof setInterval> | undefined

/**
 * What the user sees, rebuilt from what the model was told.
 *
 * Shared so opening a conversation from the dialog and resuming one by id
 * cannot drift into showing different things.
 */
function fromMessages(list: Message[]): Entry[] {
  const out: Entry[] = []
  for (const message of list) {
    if (message.role === "user") out.push({ kind: "user", text: message.content })
    else if (message.role === "assistant" && message.content) out.push({ kind: "agent", text: message.content })
  }
  return out
}
function spinnerFrame() {
  return SPINNER[spinnerTick % SPINNER.length]!
}

function startSpinner() {
  if (spinnerTimer) return
  spinnerTimer = setInterval(() => {
    spinnerTick++
    render()
  }, 90)
  spinnerTimer.unref?.()
}

function stopSpinner() {
  if (spinnerTimer) clearInterval(spinnerTimer)
  spinnerTimer = undefined
}
let status = key ? "" : "no key for " + selection.provider.label

/** A question waiting on an answer. `cover` is what "Allow for this session" would approve, in words. */
let pending: { tool: string; detail: string; cover: string; resolve: (d: Decision) => void } | undefined
/** Which answer is highlighted. Starts on "allow once", the least committal. */
let pendingChoice = 0

/**
 * A panel you read and dismiss.
 *
 * /status used to print into the transcript, where it stayed forever and
 * pushed the conversation up. It is a glance, not a message.
 */
/**
 * Entering a key.
 *
 * While this is set the composer stops being a composer: what is typed is
 * drawn as dots, never reaches the transcript, never joins the prompt
 * history, and is handed straight to the auth store. A key that is echoed
 * once is a key in a screenshot forever.
 */
let secret: { provider: string } | undefined

let overlay: { title: string; rows: [string, string][] } | undefined
/** The popup, when there is one. Only ever one: dialogs replace, not stack. */
let dialog: Dialogs.Dialog | undefined
/** Which files are expanded in the diff viewer. */
const diffOpen = new Set<string>()
/** The last diff computed, so expanding a file does not recompute it. */
let lastChanges: Changes | undefined
/** Which setting is having its value chosen. */
let settingBeing: string | undefined
// withConfig rather than new: the deny rules in codegoblin.jsonc have to reach
// the agent this terminal drives, and a test fails if a surface builds one
// without them.
const permissions = Permissions.withConfig(
  (tool, detail, cover) =>
    new Promise<Decision>((resolve) => {
      pending = { tool, detail, cover, resolve }
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
  // A key is not a command and not a mention. Matching it against either
  // would put part of it on screen in a palette row.
  if (secret) { palette = undefined; return }
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

/**
 * Break the prompt into lines that fit.
 *
 * It used to scroll sideways: a long prompt ran off to the right and you
 * could only ever see the tail of it. It grows downward now, up to a limit,
 * because a composer that eats the whole screen is its own problem.
 *
 * Measured in display width, so a line of CJK wraps where it looks like it
 * should rather than at twice the width.
 */
const COMPOSER_MAX_LINES = 6

function wrapToWidth(text: string, width: number): string[] {
  if (width <= 0) return [text]
  const rows: string[] = []
  let row = ""
  let used = 0
  for (const char of text) {
    const w = charWidthOf(char)
    if (used + w > width) {
      rows.push(row)
      row = ""
      used = 0
    }
    row += char
    used += w
  }
  rows.push(row)
  return rows
}

/** Which wrapped line the caret sits on, and how far along it. */
function caretIn(rows: string[], cursor: number): { line: number; column: number } {
  let seen = 0
  for (const [index, row] of rows.entries()) {
    const length = [...row].length
    if (cursor <= seen + length) return { line: index, column: displayWidth([...row].slice(0, cursor - seen).join("")) }
    seen += length
  }
  const last = rows.length - 1
  return { line: last, column: displayWidth(rows[last] ?? "") }
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
  const promptHeight = input && !secret && !streaming && !pending
    ? Math.min(COMPOSER_MAX_LINES, wrapToWidth(input, Math.max(10, cols - 8)).length)
    : 1
  /**
   * Everything drawn below the conversation, counted before the conversation
   * is measured against it.
   *
   * The palette and the plan were counted; the popups were not. So opening
   * one made the frame taller than the terminal, and the terminal answered
   * the only way it can - by scrolling, which pushed the top of the screen
   * away. /status was the clearest case: ten rows of panel, ten rows of frame
   * gone off the top.
   *
   * Both boxes are title, rows, and two borders.
   */
  const overlayHeight = overlay ? overlay.rows.length + 3 : 0
  const pendingHeight = pending ? DECISIONS.length + 3 : 0
  const composerHeight =
    3 + promptHeight + paletteLines.length + planLines.length + overlayHeight + pendingHeight
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
    // Wide enough for the title too: a heading longer than the widest row
    // used to run straight through the right-hand border.
    const inner = Math.max(labelWidth + valueWidth + 4, displayWidth(overlay.title) + 4)
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
    // The box names what is being asked and what "for this session" would
    // cover. It used to say only "allow this?", with the command down in the
    // input line, and the session hint said "calls like this" - which told you
    // nothing once an approval covered one command rather than the whole tool.
    const asked = (pending.tool === "shell" ? commandOf(pending.detail) : pending.detail).replace(/\s+/g, " ")
    const title = " allow " + pending.tool + ": " + asked + "?"
    const hints = DECISIONS.map((d) => (d.id === "always" ? "stop asking about " + pending!.cover : d.hint))
    // One width for every row, padded after colouring - displayWidth skips
    // escape sequences, so the box lines up whatever colour the text is. As
    // wide as the words need, but never wider than the terminal.
    const labelWidth = Math.max(...DECISIONS.map((d) => displayWidth(d.label))) + 2
    const wanted = Math.max(3 + labelWidth + Math.max(...hints.map((hint) => displayWidth(hint))), displayWidth(title)) + 1
    const inner = Math.max(24, Math.min(wanted, cols - 6))

    body.push(theme.border + "  " + "╭" + "─".repeat(inner) + "╮" + ansi.reset)
    body.push(
      theme.border + "  │" + ansi.reset +
        theme.gold + padToWidth(truncateToWidth(title, inner), inner) + ansi.reset +
        theme.border + "│" + ansi.reset,
    )
    for (const [index, choice] of DECISIONS.entries()) {
      const active = index === pendingChoice
      const marker = active ? theme.goblin + " ❯ " + ansi.reset : "   "
      const label = (active ? theme.text : theme.muted) + padToWidth(choice.label, labelWidth) + ansi.reset
      const hint = truncateToWidth(hints[index]!, Math.max(0, inner - 3 - labelWidth))
      const row = marker + label + dim + hint + ansi.reset
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
  /** The prompt as it will be drawn, one entry per visible line. */
  let composerRows: string[] = []
  /** Characters of prompt scrolled off above the first drawn row. */
  let rowsBefore = 0
  let caretLine = 0
  let shown: string
  if (pending) {
    shown =
      theme.gold + pending.tool + ansi.reset + " " +
      dim + pending.detail.slice(0, Math.max(10, visibleInput - 24)) + ansi.reset
  } else if (streaming && !input) {
    caretOffset = 0
    shown =
      dim + spinnerFrame() + " goblin is working... " + ansi.reset +
      dim + "type to steer" + ansi.reset
  } else if (secret) {
    // Dots, and one per character rather than a fixed run, so backspace is
    // visible without the key ever being.
    caretOffset = displayWidth(secret.provider) + 7 + input.length
    shown =
      theme.gold + secret.provider + " key: " + ansi.reset +
      theme.text + "\u00b7".repeat(Math.min(input.length, Math.max(4, visibleInput - 24))) + ansi.reset
  } else if (!input) {
    caretOffset = 0
    shown = dim + "ask the goblin anything..." + ansi.reset
  } else {
    const span = composerSelection(composerState())
    const rows = wrapToWidth(input, visibleInput)
    const spot = caretIn(rows, cursor)
    // Keep the caret's line on screen when the prompt outgrows the box.
    const first = Math.max(0, Math.min(spot.line - COMPOSER_MAX_LINES + 1, rows.length - COMPOSER_MAX_LINES))
    composerRows = rows.slice(first, first + COMPOSER_MAX_LINES)
    rowsBefore = rows.slice(0, first).join("").length
    caretLine = spot.line - first
    caretOffset = spot.column
    // A selection is drawn in reverse video, which is what every terminal
    // editor does and what makes it read as selected rather than as text
    // that happens to be a different colour.
    const before = rows.slice(0, first).join("").length
    const line = composerRows[0] ?? ""
    if (span && composerRows.length === 1) {
      const from = Math.max(0, Math.min(span.from - before, line.length))
      const to = Math.max(0, Math.min(span.to - before, line.length))
      shown =
        theme.text + line.slice(0, from) +
        invert + line.slice(from, to) + noInvert +
        line.slice(to) + ansi.reset
    } else {
      shown = theme.text + line + ansi.reset
    }
  }

  body.push(theme.border + "  " + "-".repeat(inner) + ansi.reset)
  if (composerRows.length > 1) {
    let seen = rowsBefore
    for (const row of composerRows) {
      const start = seen
      const end = seen + row.length
      seen = end
      const span = composerSelection(composerState())
      if (!span || span.to <= start || span.from >= end) {
        body.push(theme.goblin + "  | " + ansi.reset + theme.text + row + ansi.reset)
        continue
      }
      const from = Math.max(0, span.from - start)
      const to = Math.min(row.length, span.to - start)
      body.push(
        theme.goblin + "  | " + ansi.reset +
          theme.text + row.slice(0, from) +
          invert + row.slice(from, to) + noInvert +
          row.slice(to) + ansi.reset,
      )
    }
  } else {
    body.push(theme.goblin + "  | " + ansi.reset + shown)
  }
  body.push(theme.border + "  " + "-".repeat(inner) + ansi.reset)

  const context = usage(messages, selection.model.contextWindow)
  const modeTag = permissions.mode === "ask" ? "" : "  [" + permissions.mode + "]"
  const spendTag = spend.input + spend.output > 0 ? "  " + formatSpend(spend) : ""
  const left =
    status ||
    modeTag.trim() + (modeTag ? "  " : "") +
      selection.provider.label + " . " + selection.model.id +
      "  " + context.percent + "% ctx" + spendTag
  const right = dialog
    ? "up/down move . enter chooses . esc closes"
    : streaming
    ? (queued ? "queued . esc stops" : "enter queues . esc stops")
    : secret
    ? "enter saves . esc cancels . nothing is echoed"
    : overlay
    ? "any key closes"
    : pending
    ? "up/down choose . enter confirm . esc reject"
    : scroll > 0
      ? "scrolled " + scroll
      : palette
        ? "tab complete . up/down pick"
        : "pgup/dn scroll . shift+tab mode . ctrl+c quit"
  const plain = "  " + left
  const padded = padToWidth(plain, Math.max(displayWidth(plain) + 1, cols - displayWidth(right) - 2))
  body.push(dim + padded + ansi.reset + theme.muted + right + ansi.reset)

  // Clamp on display width: CJK and emoji are two columns, so a line that
  // looks short by .length can still overflow and wrap.
  const clamped = body.map((line) => (displayWidth(line) <= cols ? line : truncateToWidth(line, cols - 1) + ansi.reset))

  // rule, prompt lines, rule, status - so the caret's row counts back past
  // however many lines the prompt currently takes.
  const promptLines = Math.max(1, composerRows.length)
  caretAt =
    caretOffset === undefined
      ? undefined
      : { row: body.length - promptLines - 1 + caretLine, col: 5 + caretOffset }

  // A dialog goes over the top, with the conversation dimmed behind it.
  // The caret is hidden while one is open: the composer is not where the
  // keys are going, and a blinking caret there would say it was.
  const painted = dialog ? Dialogs.compose(clamped, Dialogs.box(dialog, cols, rows), cols, rows) : clamped
  const showCaret = caretAt && !dialog

  out.write(
    theme.ground + ansi.hideCursor + ansi.clear + painted.join(String.fromCharCode(10)) +
      (showCaret ? ansi.moveTo(caretAt!.row, caretAt!.col) + ansi.showCursor : ""),
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
  startSpinner()
  transcript.push({ kind: "user", text: line })
  render()
  const generated = await runMedia(
    kind,
    line,
    process.cwd(),
    { provider: selection.provider.id, model: selection.model.id },
    media,
  )
  streaming = false
  stopSpinner()
  transcript.push({ kind: "tool", text: describeMedia(generated) })
  status = generated.ok ? "" : "generation failed"
  render()
}

/**
 * Fetch the account's voices, once, the first time somebody looks.
 *
 * Not at startup: most sessions never generate a sound, and a network call
 * on launch to fill a list nobody opens is a launch that is slower for no
 * reason. The palette says it is loading in the meantime.
 */
let loadingVoices = false
let voicesLoaded = false
/** Why the list is empty, when it is: no key and none saved read differently. */
let voicesNote = ""
async function loadVoices() {
  if (loadingVoices) return
  loadingVoices = true
  try {
    const { CodeGoblinAudioCommand } = await import("../domain/audio-command")
    const result = await CodeGoblinAudioCommand.voices({ cwd: process.cwd() })
    voices = result.ok ? result.voices.map((voice) => ({ id: voice.id, label: voice.name })) : []
    // An empty list because there is no key reads very differently from an
    // empty list because the account has none, so the reason is kept.
    voicesNote = result.ok ? "" : result.message
    voicesLoaded = true
  } catch {
    // A voice list that will not load is a shorter list, not an error worth
    // interrupting anyone over.
    voices = []
    voicesNote = "could not reach the voice list"
    voicesLoaded = true
  }
  refreshPalette()
  // A settings dialog opened before the voices landed is rebuilt with them.
  if (dialog?.kind === "setting-value" && settingBeing) openSettingValues(settingBeing)
  render()
}

/**
 * The dialogs.
 *
 * All three are the same widget with different rows, which is the point of
 * having a widget at all - the last version of settings was two slash
 * commands where one had to know the other's grammar, and every list here
 * would have needed its own version of that.
 */

/** Files this session has changed, newest and largest first. */
async function openDiff() {
  const changes = await changesIn(process.cwd(), edits)
  if (!changes.files.length) {
    status = "no file has been changed this session"
    return
  }
  diffOpen.clear()
  dialog = Dialogs.open("diff", "Changes  " + summarise(changes), diffRows(changes), {
    footer: "enter opens a file . n/p next and previous . q or esc closes",
    size: "full",
  })
  lastChanges = changes
}

/** One row per file, plus the lines of whichever files are open. */
function diffRows(changes: Changes): Dialogs.DialogRow[] {
  const rows: Dialogs.DialogRow[] = []
  for (const file of changes.files) {
    const open = diffOpen.has(file.path)
    rows.push({
      label: (open ? "\u25be " : "\u25b8 ") + statusLetter(file) + "  " + file.path,
      hint: countsOf(file) + (file.truncated ? "  (summary)" : ""),
      value: file.path,
      tone: file.status === "added" ? "added" : file.status === "removed" ? "removed" : "text",
    })
    if (!open) continue
    for (const hunk of file.hunks) {
      rows.push({
        label: "    @@ -" + hunk.beforeStart + "," + hunk.beforeCount + " +" + hunk.afterStart + "," + hunk.afterCount + " @@",
        tone: "gold",
        inert: true,
      })
      for (const line of hunk.lines) {
        const sign = line.kind === "add" ? "+" : line.kind === "remove" ? "-" : " "
        const number = String(line.after ?? line.before ?? "").padStart(5)
        rows.push({
          label: "  " + number + " " + sign + line.text,
          tone: line.kind === "add" ? "added" : line.kind === "remove" ? "removed" : "muted",
          inert: true,
        })
      }
    }
    if (!file.hunks.length) {
      rows.push({ label: "    (no line changes)", tone: "muted", inert: true })
    }
  }
  return rows
}

/** Saved conversations, with the one you are in marked. */
async function openSessions() {
  const saved = await sessions.list(60)
  if (!saved.length) {
    status = "no saved conversations yet"
    return
  }
  dialog = Dialogs.open(
    "sessions",
    "Conversations",
    saved.map((entry) => ({
      label: (entry.id === session.id ? "\u2022 " : "  ") + entry.title,
      hint: entry.id === session.id ? "open" : "",
      value: entry.id,
    })),
    { footer: "enter opens . ctrl+d twice deletes . esc closes", size: "large" },
  )
}

/**
 * Which key to forget.
 *
 * /disconnect used to demand the provider id typed from memory, and the id is
 * not the label - "zai" is GLM, "google" is Gemini. The list already existed
 * for /connect; this makes it something you can choose from.
 */
function openDisconnect() {
  const stored = connections().filter((item) => item.source === "file")
  if (!stored.length) {
    status = "no stored keys to remove"
    return
  }
  dialog = Dialogs.open(
    "disconnect",
    "Remove a stored key",
    stored.map((item) => ({
      label: item.id,
      hint: item.type + (item.hint ? "  " + item.hint : ""),
      value: item.id,
    })),
    { footer: "enter twice removes this key . esc closes", size: "medium" },
  )
}

/**
 * Which colours.
 *
 * Five schemes is a list to look at, not a set of names to memorise, and
 * typing one from a printed list is the interaction a picker exists to
 * replace. Each row carries its own description, so the choice is made on
 * what the theme is rather than on what it is called.
 */
function openThemePicker() {
  dialog = Dialogs.open(
    "theme",
    "Colours",
    Object.entries(THEMES).map(([name, entry]) => ({
      label: (name === settings.theme ? "• " : "  ") + name,
      hint: entry.label,
      value: name,
    })),
    { footer: "enter applies . esc closes", size: "medium" },
  )
}

/**
 * How hard the model should think.
 *
 * Says up front whether the model on the picker takes it at all, because
 * "high" on a model that does not reason is a preference with no effect, and
 * finding that out from the status line afterwards is finding it out late.
 */
function openEffortPicker() {
  const takes = takesEffort(selection.model)
  dialog = Dialogs.open(
    "effort",
    takes ? "Effort  ·  " + selection.model.label : "Effort  ·  " + selection.model.label + " does not reason",
    EFFORTS.map((level) => ({
      label: (level === settings.effort ? "• " : "  ") + level,
      hint:
        level === "auto"
          ? "let the provider decide"
          : takes
            ? "sent as reasoning_effort"
            : "saved, but not sent to this model",
      value: level,
    })),
    { footer: "enter applies . esc closes", size: "medium" },
  )
}

/** How generation comes out. A popup, because a settings screen should be one. */
function openSettings() {
  dialog = Dialogs.open("settings", "Settings  ·  " + selection.provider.label + " " + selection.model.label, settingsRows(), {
    footer: "enter changes this setting . esc closes",
    size: "large",
  })
}

/**
 * The settings the selected model takes, and nothing else.
 *
 * This was every knob for every generator in one list, so a voice-clone
 * setting sat beside 3D topology whatever was selected, and a value chosen for
 * one model applied to another that might not take it. Settings belong to a
 * model: pick the model, and these are its settings.
 */
function settingsRows(): Dialogs.DialogRow[] {
  const provider = selection.provider.id
  const model = selection.model.id
  const options = optionsForModel(provider, model)
  if (!options.length) {
    // Say why the list is empty - a chat model has no generation settings at
    // all, which is a different answer from a generator we send nothing to.
    const why =
      kindOf(selection.model) === "text"
        ? "a chat model has no generation settings - pick an image, voice or 3D model"
        : "nothing on this model's request can be changed from here"
    return [{ label: "  " + why, tone: "muted", inert: true }]
  }
  return options.map((option) => ({
    label: "  " + option.label,
    hint: labelOf(option, valueOf(media, provider, model, option.id), voices),
    value: option.id,
  }))
}

/** The values one setting takes. Replaces the list rather than stacking on it. */
function openSettingValues(id: string) {
  const option = optionById(id)
  if (!option) return
  if (option.dynamic === "voices" && !voicesLoaded) void loadVoices()
  const current = valueOf(media, selection.provider.id, selection.model.id, option.id)
  const pool = option.dynamic === "voices"
    ? [{ id: MEDIA_DEFAULT, label: "account default" }, ...voices]
    : option.choices
  const rows: Dialogs.DialogRow[] = pool.map((choice) => ({
    label: choice.label,
    hint: choice.id === current ? "\u2713 set" : "",
    value: choice.id,
  }))
  if (option.dynamic === "voices" && !voicesLoaded) {
    rows.push({ label: "loading voices from your account\u2026", tone: "muted", inert: true })
  } else if (option.dynamic === "voices" && voicesNote) {
    rows.push({ label: voicesNote, tone: "muted", inert: true })
  }
  dialog = Dialogs.open("setting-value", option.label, rows, {
    footer: option.about,
    size: "large",
  })
  settingBeing = option.id
}
/**
 * Jump to the next or previous file header.
 *
 * A file header is a row with a value; everything under an expanded file is
 * inert. So "the next file" is simply the next row that can be selected at
 * all, which is what the arrow keys would eventually reach.
 */
function toFile(dialog: Dialogs.Dialog, direction: number): Dialogs.Dialog {
  const headers = dialog.rows
    .map((row, index) => (row.inert ? -1 : index))
    .filter((index) => index >= 0)
  if (!headers.length) return dialog
  const at = headers.findIndex((index) => index === dialog.index)
  const next = Math.max(0, Math.min(headers.length - 1, (at === -1 ? 0 : at) + direction))
  return { ...dialog, index: headers[next]!, armed: undefined }
}

function closeDialog() {
  dialog = undefined
  settingBeing = undefined
}

/** Enter, whatever the dialog happens to be. */
async function chooseInDialog() {
  if (!dialog) return
  const row = Dialogs.selected(dialog)
  if (!row || !row.value) { render(); return }

  if (dialog.kind === "diff") {
    // Opening a file rebuilds the rows in place rather than pushing a
    // second dialog, so escape still means "done reviewing".
    if (diffOpen.has(row.value)) diffOpen.delete(row.value)
    else diffOpen.add(row.value)
    if (lastChanges) dialog = Dialogs.withRows(dialog, diffRows(lastChanges))
    render()
    return
  }

  if (dialog.kind === "sessions") {
    const loaded = await sessions.load(row.value)
    if (!loaded) { status = "could not open that conversation"; closeDialog(); render(); return }
    session = loaded
    messages = session.messages
    transcript = fromMessages(session.messages)
    scroll = 0
    edits.reset()
    status = "opened " + session.title
    closeDialog()
    render()
    return
  }

  if (dialog.kind === "disconnect") {
    // Two presses, like deleting a conversation. A key is not recoverable
    // from here - once it is gone the only way back is finding it again
    // wherever it came from - and one keystroke is not enough of a gap
    // between "which one is this?" and "that one is gone".
    if (dialog.armed !== row.value) {
      dialog = { ...dialog, armed: row.value }
      render()
      return
    }
    const gone = await disconnect(row.value)
    refreshConnected()
    status = gone ? "disconnected " + row.value : "no stored key for " + row.value
    closeDialog()
    render()
    return
  }

  if (dialog.kind === "theme") {
    settings = { ...settings, theme: row.value }
    applyTheme(row.value)
    void settingsStore.save(settings)
    status = "theme: " + row.value
    closeDialog()
    render()
    return
  }

  if (dialog.kind === "effort") {
    settings = { ...settings, effort: row.value as settingsStore.Effort }
    void settingsStore.save(settings)
    status =
      row.value === "auto"
        ? "effort: auto - the provider decides"
        : selection.model.reasoning
          ? "effort: " + row.value
          : "effort: " + row.value + " (saved; " + selection.model.label + " does not reason)"
    closeDialog()
    render()
    return
  }

  if (dialog.kind === "settings") {
    openSettingValues(row.value)
    render()
    return
  }

  if (dialog.kind === "setting-value" && settingBeing) {
    media = withValue(media, selection.provider.id, selection.model.id, settingBeing, row.value)
    void saveMedia(media)
    const option = optionById(settingBeing)
    status = option ? option.label + ": " + labelOf(option, row.value, voices) : "saved"
    // Back to the list it came from, so several can be changed in a row.
    settingBeing = undefined
    openSettings()
    render()
    return
  }

  closeDialog()
  render()
}

/**
 * ctrl+d, which only means anything in the session list.
 *
 * Two presses, the way the original does it: the row says so in between.
 * A confirmation dialog stacked on a dialog is worse than what it guards.
 */
async function deleteInDialog() {
  if (!dialog || dialog.kind !== "sessions") { render(); return }
  const row = Dialogs.selected(dialog)
  if (!row || !row.value) { render(); return }

  if (dialog.armed !== row.value) {
    dialog = { ...dialog, armed: row.value }
    render()
    return
  }

  const gone = await sessions.remove(row.value)
  if (!gone) {
    status = "could not delete that conversation"
    dialog = { ...dialog, armed: undefined }
    render()
    return
  }
  // Deleting the one you are in leaves you somewhere real rather than in a
  // conversation whose file is gone.
  if (row.value === session.id) {
    session = sessions.create(selection.provider.id)
    messages = []
    transcript = []
    edits.reset()
  }
  await refreshSessionCache()
  const saved = await sessions.list(60)
  if (!saved.length) {
    status = "deleted - no conversations left"
    closeDialog()
    render()
    return
  }
  dialog = Dialogs.withRows(
    dialog,
    saved.map((entry) => ({
      label: (entry.id === session.id ? "\u2022 " : "  ") + entry.title,
      hint: entry.id === session.id ? "open" : "",
      value: entry.id,
    })),
  )
  status = "deleted"
  render()
}

async function send() {
  if (secret) {
    const provider = secret.provider
    const key = input
    // Cleared before the await, so a slow disk cannot leave it on screen.
    input = ""
    cursor = 0
    secret = undefined
    try {
      await connect(provider, key)
      refreshConnected()
      status = "connected " + provider + " - stored in " + storePath()
    } catch (error) {
      status = error instanceof Error ? error.message : "could not store the key"
    }
    render()
    return
  }

  const text = input.trim()
  if (!text || streaming) return

  // A custom command or a skill reads like a command but is a message: its
  // text is what the model gets, and the line typed is what the transcript shows.
  const invoked = isCommand(text) ? resolveInvocation(text, process.cwd()) : undefined

  if (isCommand(text) && !invoked) {
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
      pastes = []
      spend = { input: 0, output: 0 }
      overlay = undefined
      status = "new conversation"
    }
    if (result.kind === "message") transcript.push({ kind: "tool", text: result.text })
    if (result.kind === "theme") {
      if (!result.name) { openThemePicker(); render(); return }
      settings = { ...settings, theme: result.name }
      applyTheme(result.name)
      void settingsStore.save(settings)
      status = "theme: " + result.name
    }
    if (result.kind === "effort") {
      if (!result.level) { openEffortPicker(); render(); return }
      settings = { ...settings, effort: result.level }
      void settingsStore.save(settings)
      status =
        result.level === "auto"
          ? "effort: auto - the provider decides"
          : takesEffort(selection.model)
            ? "effort: " + result.level
            : "effort: " + result.level + " (saved; " + selection.model.label + " does not reason)"
    }
    if (result.kind === "mouse") {
      settings = { ...settings, mouse: !settings.mouse }
      void settingsStore.save(settings)
      applyMouse()
      status = settings.mouse
        ? "mouse on - wheel scrolls, shift+drag selects"
        : "mouse off - drag selects text, pgup/dn scrolls"
    }
    if (result.kind === "settings") { openSettings(); render(); return }
    if (result.kind === "diff") { await openDiff(); render(); return }
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
    if (result.kind === "connect") {
      if (result.provider) {
        secret = { provider: result.provider }
        status = envVariable(result.provider) + " would also work, without storing anything"
      } else {
        const rows = connections().map(
          (item) =>
            [item.id, item.type + "  " + item.source + (item.hint ? "  " + item.hint : "")] as [string, string],
        )
        overlay = {
          title: "connected providers  (/connect <name> to add)",
          rows: rows.length ? rows : [["", "nothing connected yet"]],
        }
      }
    }
    if (result.kind === "disconnect") {
      if (!result.provider) {
        openDisconnect()
      } else {
        const gone = await disconnect(result.provider)
        refreshConnected()
        status = gone ? "disconnected " + result.provider : "no stored key for " + result.provider
      }
    }
    if (result.kind === "skills") {
      // Into the transcript rather than a panel: there can be dozens, and the
      // transcript scrolls.
      const skills = listSkills(process.cwd())
      const commands = customCommands(process.cwd())
      const lines = [
        ...commands.map((command) => "/" + command.name + "  command (" + command.scope + ")" + (command.description ? " - " + command.description : "")),
        ...skills.map(
          (skill) =>
            "/" + skill.name + "  skill (" + skill.scope + (skill.modelInvocable ? "" : ", only you can start it") +
            (skill.userInvocable ? "" : ", only the model can start it") + ")",
        ),
      ]
      transcript.push({
        kind: "tool",
        text: lines.length
          ? skills.length + " skills, " + commands.length + " custom commands" + String.fromCharCode(10) + lines.join(String.fromCharCode(10))
          : "no skills or custom commands yet - a skill is a folder with a SKILL.md in ~/.claude/skills",
      })
    }
    if (result.kind === "mcp") {
      const servers = mcp.statuses()
      const rows: [string, string][] = servers.length
        ? servers.map((server): [string, string] => [
            server.name,
            server.status === "connected"
              ? server.tools.length + " tool" + (server.tools.length === 1 ? "" : "s") +
                (server.tools.length ? ": " + server.tools.join(", ") : "")
              : server.status + (server.error ? " - " + server.error : ""),
          ])
        : [["none yet", 'add servers under "mcp" in ' + configPath()]]
      overlay = { title: "mcp servers", rows }
    }
    if (result.kind === "status") {
      const context = usage(messages, selection.model.contextWindow)
      const approved = permissions.summary()
      const rows: [string, string][] = [
        ["model", selection.provider.label + " " + selection.model.label],
        ["session", session.title + "  (" + messages.length + " messages)"],
        ["context", context.percent + "% of " + selection.model.contextWindow.toLocaleString()],
        [
          "spent",
          spend.input + spend.output > 0
            ? formatSpend(spend) + "  (" + spend.input.toLocaleString() + " in, " + spend.output.toLocaleString() + " out)"
            : "nothing yet",
        ],
        ["theme", settings.theme],
        ["thinking", settings.thinking ? "shown" : "hidden"],
        [
          "effort",
          settings.effort === "auto"
            ? "auto"
            : settings.effort + (takesEffort(selection.model) ? "" : "  (not sent - this model does not take it)"),
        ],
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
      // No id opens the picker, which is also the only place a conversation
      // can be deleted. Printing a list of ids to copy was never the plan.
      if (!result.id) {
        await openSessions()
        render()
        return
      } else {
        const loaded = await sessions.load(result.id)
        if (!loaded) status = "no such conversation: " + result.id
        else {
          session = loaded
          messages = loaded.messages
          transcript = fromMessages(messages)
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
  // What was folded away goes back before anything sees it.
  const whole = invoked ? invoked.content : unfoldPastes(text)
  const mentioned = await expandMentions(whole, process.cwd())
  const seeing = acceptsImages(selection)
  messages.push(
    mentioned.files.length || whole !== text
      ? { role: "user", content: mentioned.content, display: text, images: mentioned.images }
      : { role: "user", content: text },
  )
  transcript.push({ kind: "user", text })
  if (mentioned.files.length) transcript.push({ kind: "tool", text: "attached " + mentioned.files.join(", ") })
  // Attaching a picture to a model that cannot see one is a mistake worth
  // catching here, where the model is named, rather than leaving it to be
  // inferred from an answer that does not mention the image.
  if (mentioned.images.length && !seeing) {
    transcript.push({
      kind: "tool",
      text: selection.model.label + " cannot see images - pick a vision model to send " +
        mentioned.images.map((image) => image.name).join(", "),
    })
  }
  streaming = true
  status = ""
  startSpinner()
  render()

  let current: Entry | undefined
  turn = new AbortController()
  // Everything this turn writes is captured under one checkpoint, so /undo
  // takes back the whole answer rather than its last file.
  edits.begin(text)
  try {
    // Servers still starting get a moment, so a first message can use their tools.
    const starting = mcp.connecting()
    if (starting.length) {
      status = "waiting for MCP servers: " + starting.join(", ")
      render()
    }
    await mcp.settled(10_000)
    if (starting.length) status = ""
    for await (const event of runAgent({
      provider: selection.provider,
      modelId: selection.model.id,
      apiKey: key,
      messages,
      root: process.cwd(),
      contextWindow: selection.model.contextWindow,
      images: seeing,
      permissions,
      history: edits,
      extraTools: mcp,
      effort: effortFor(selection.model, settings.effort),
      signal: turn.signal,
      memory: await memory.recall({ project: process.cwd(), session: session.id }),
      instructions: skillIndex(listSkills(process.cwd())),
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
        transcript.push({ kind: "tool", call: event.id, text: event.name + " " + event.args.slice(0, 60) })
      }
      if (event.type === "spend") {
        spend = addSpend(spend, {
          input: event.input,
          output: event.output,
          dollars: priceOf(event, selection.model.price),
        })
      }
      if (event.type === "plan") {
        plan = event.todos
      }
      if (event.type === "compacted") {
        transcript.push({ kind: "tool", text: "compacted context: " + event.before + " -> " + event.after + " messages" })
      }
      // The loop ran out of turns while the model was still calling tools, so
      // whatever is above is unfinished. It used to end exactly like a
      // finished answer, which made a half-done turn impossible to spot.
      if (event.type === "limit") {
        current = undefined
        transcript.push({
          kind: "tool",
          text: "stopped after " + event.turns + " tool turns - the answer may be unfinished, ask it to continue",
        })
        status = "hit the turn limit"
      }
      // Found by call id rather than by being last: several tools can be open
      // at once now, so "the most recent row" is no longer the right one.
      const rowFor = (id: string) =>
        [...transcript].reverse().find((entry) => entry.kind === "tool" && entry.call === id)

      if (event.type === "tool_denied") {
        const row = rowFor(event.id)
        // Whose decision it was: a rule, plan mode, or you. It said "refused"
        // for all three, so a command a rule stopped read as one you declined.
        if (row) row.text += "  (" + refusalLabel(event) + ")"
      }
      if (event.type === "tool_end") {
        const row = rowFor(event.id)
        if (row) {
          const firstLine = event.result.split(String.fromCharCode(10))[0] ?? ""
          row.text += "  ->  " + firstLine.slice(0, 50)
        }
      }
      render()
    }
  } catch (error) {
    // Stopping is not a failure, and the runtime word for it is not one
    // anybody asked to read.
    status = turn?.signal.aborted
      ? "stopped"
      : error instanceof Error
        ? error.message.slice(0, 120)
        : "request failed"
  } finally {
    streaming = false
    stopSpinner()
    turn = undefined
    edits.commit()
    session.messages = messages
    void sessions.save(session).then(refreshSessionCache).catch(() => {})

    // Anything typed mid-turn goes now, without a keystroke to remind it.
    if (queued) {
      const next = queued
      queued = undefined
      input = next
      cursor = next.length
      void send()
      return
    }
    render()
  }
}

function shutdown() {
  out.write("[0m" + ansi.pasteOff + ansi.releaseMouse + ansi.showCursor + ansi.mainScreen)
  // MCP servers started as child processes go with the app, but one that will
  // not close is not allowed to keep the terminal waiting.
  void Promise.race([mcp.close(), new Promise((done) => setTimeout(done, 1500))]).finally(() => process.exit(0))
}

async function refreshSessionCache() {
  // Kept as a hook: the picker reads the store directly now, but saving a
  // session still wants somewhere to say so as the list grows other readers.
  await sessions.list(1)
}
void refreshSessionCache()

async function refreshFileCache() {
  setFileCache(await globFiles(process.cwd(), "**/*", 4000).catch(() => []))
}
void refreshFileCache()

/**
 * Hand the mouse to the app, or leave it to the terminal.
 *
 * Taking it gets the wheel and clickable things; leaving it keeps the
 * terminal's own drag-to-select. The original makes this a setting rather
 * than a choice, which is the right call - so does this.
 */
function applyMouse() {
  out.write(settings.mouse ? ansi.takeMouse : ansi.ownMouse)
}

function refreshConnected() {
  setConnectedProviders(connections().map((item) => item.id))
}
refreshConnected()

async function loadSettings() {
  settings = await settingsStore.load()
  media = await loadMedia()
  applyTheme(settings.theme)
  applyMouse()
  render()
}
void loadSettings()

out.write(ansi.altScreen + ansi.ownMouse + ansi.pasteOn)
render()
out.on("resize", render)

process.stdin.setRawMode?.(true)
process.stdin.resume()
// One reader for the whole session, so a paste split across chunks is still
// one paste.
const readKeys = createKeyReader()

process.stdin.on("data", (chunk) => {
  let dirty = false

  for (const pressed of readKeys(chunk.toString())) {
    if (pressed.type === "ctrl" && pressed.value === "c") return shutdown()

    // A dialog owns the keyboard while it is open. Nothing behind it moves,
    // which is the difference between a popup and a panel.
    if (dialog) {
      const height = Dialogs.dialogHeight(dialog, size().rows)
      if (pressed.type === "escape") { closeDialog(); render(); continue }
      if (pressed.type === "up") { dialog = Dialogs.move(dialog, -1); render(); continue }
      if (pressed.type === "down") { dialog = Dialogs.move(dialog, 1); render(); continue }
      if (pressed.type === "wheelup") { dialog = Dialogs.move(dialog, -3); render(); continue }
      if (pressed.type === "wheeldown") { dialog = Dialogs.move(dialog, 3); render(); continue }
      if (pressed.type === "pageup") { dialog = Dialogs.move(dialog, -height); render(); continue }
      if (pressed.type === "pagedown") { dialog = Dialogs.move(dialog, height); render(); continue }
      if (pressed.type === "home") { dialog = Dialogs.move(dialog, -dialog.rows.length); render(); continue }
      if (pressed.type === "end") { dialog = Dialogs.move(dialog, dialog.rows.length); render(); continue }
      if (pressed.type === "enter") { void chooseInDialog(); continue }
      if (pressed.type === "ctrl" && pressed.value === "d") { void deleteInDialog(); continue }
      // q closes the diff viewer, the way the original binds it - reviewing
      // is a mode you leave, and reaching for escape every time is a tell
      // that nobody who reads diffs was asked.
      if (dialog.kind === "diff" && pressed.type === "char" && pressed.value === "q") {
        closeDialog()
        render()
        continue
      }
      // n and p jump between files in the diff, which is the only way to get
      // past a long one without holding the down arrow.
      if (dialog.kind === "diff" && pressed.type === "char" && (pressed.value === "n" || pressed.value === "p")) {
        dialog = toFile(dialog, pressed.value === "n" ? 1 : -1)
        render()
        continue
      }
      // Anything else is swallowed rather than typed into the composer
      // behind: a key pressed at a dialog was meant for the dialog.
      continue
    }
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
      // Escape stops the turn. Everything already streamed stays: an
      // interrupted answer is still worth reading, and the conversation
      // survives, which is the whole difference from ctrl+c.
      if (pressed.type === "escape") {
        if (input) {
          // A half-written steer is thrown away first; stopping the model
          // is the second press, so neither is done by accident.
          input = ""
          cursor = 0
          render()
          continue
        }
        turn?.abort()
        status = "stopped"
        render()
      }

      // Everything else composes. Enter queues rather than sends, because
      // the turn in flight has to finish before the next one starts.
      if (pressed.type === "enter") {
        if (input.trim()) {
          queued = input
          input = ""
          cursor = 0
          status = "queued - sending when this turn ends"
        }
        render()
        continue
      }
      if (pressed.type === "char") {
        input = input.slice(0, cursor) + pressed.value + input.slice(cursor)
        cursor += pressed.value.length
        render()
        continue
      }
      if (pressed.type === "paste") {
        const value = foldPaste(pressed.value.replace(/\r\n?/g, String.fromCharCode(10)))
        input = input.slice(0, cursor) + value + input.slice(cursor)
        cursor += value.length
        render()
        continue
      }
      if (pressed.type === "backspace") {
        if (cursor > 0) { input = input.slice(0, cursor - 1) + input.slice(cursor); cursor-- }
        render()
        continue
      }
      if (pressed.type === "left") { cursor = Math.max(0, cursor - 1); render(); continue }
      if (pressed.type === "right") { cursor = Math.min(input.length, cursor + 1); render(); continue }
      // Scrolling has to keep working while the model writes.
      if (pressed.type === "pageup") { scroll += 5; render() }
      if (pressed.type === "pagedown") { scroll = Math.max(0, scroll - 5); render() }
      if (pressed.type === "shiftup") { scroll += 1; render() }
      if (pressed.type === "shiftdown") { scroll = Math.max(0, scroll - 1); render() }
      if (pressed.type === "wheelup") { scroll += 3; render() }
      if (pressed.type === "wheeldown") { scroll = Math.max(0, scroll - 3); render() }
      continue
    }

    // While the palette is open it owns up, down, tab and escape.
    if (palette) {
      if (pressed.type === "up") { paletteIndex = Math.max(0, paletteIndex - 1); dirty = true; continue }
      if (pressed.type === "down") { paletteIndex = Math.min(palette.length - 1, paletteIndex + 1); dirty = true; continue }
      if (pressed.type === "escape") { palette = undefined; render(); continue }
      if (pressed.type === "enter") {
        // The list can change between keystrokes; never trust the index.
        const selected = palette[paletteIndex]
        if (!selected) { palette = undefined; render(); continue }
        const chosen = selected.value

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
        const selected = palette[paletteIndex]
        if (!selected) { palette = undefined; render(); continue }
        completeWith(selected.value)
        refreshPalette()
        dirty = true
        continue
      }
    }

    switch (pressed.type) {
      // Escape clears the line; it never exits. Quitting is ctrl+c.
      case "shifttab": {
        permissions.mode = nextMode(permissions.mode)
        const mode = MODES.find((entry) => entry.id === permissions.mode)!
        status = "mode: " + mode.label + " - " + mode.hint
        dirty = true
        break
      }
      case "paste": {
        // Newlines inside a paste are content. A paste that is only one
        // short line is just typing, and goes in as it is.
        const value = foldPaste(pressed.value.replace(/\r\n?/g, String.fromCharCode(10)))
        applyComposer(insertText(composerState(), value), true)
        dirty = true
        break
      }
      case "escape":
        if (secret) { secret = undefined; input = ""; cursor = 0; anchor = undefined; status = "cancelled"; dirty = true; break }
        // Escape drops a selection before it clears the line, so losing a
        // highlight does not also lose everything you had written.
        if (anchor !== undefined) { anchor = undefined; dirty = true; break }
        if (input) { applyComposer({ text: "", cursor: 0 }, true); dirty = true }
        break
      case "enter": void send(); return
      case "backspace":
        applyComposer(deleteRange(composerState(), "back"), true)
        dirty = true
        refreshPalette()
        break
      case "delete":
        applyComposer(deleteRange(composerState(), "forward"), true)
        dirty = true
        refreshPalette()
        break
      case "left": {
        const state = composerState()
        const to = pressed.ctrl ? wordStart(input, cursor) : cursor - 1
        applyComposer(moveTo(state, { to, select: Boolean(pressed.shift) }))
        dirty = true
        break
      }
      case "right": {
        const state = composerState()
        const to = pressed.ctrl ? wordEnd(input, cursor) : cursor + 1
        applyComposer(moveTo(state, { to, select: Boolean(pressed.shift) }))
        dirty = true
        break
      }
      case "home":
        applyComposer(moveTo(composerState(), { to: 0, select: Boolean(pressed.shift) }))
        dirty = true
        break
      case "end":
        applyComposer(moveTo(composerState(), { to: input.length, select: Boolean(pressed.shift) }))
        dirty = true
        break
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
      case "wheelup": scroll += 3; dirty = true; break
      case "wheeldown": scroll = Math.max(0, scroll - 3); dirty = true; break
      case "shiftup": scroll += 1; dirty = true; break
      case "shiftdown": scroll = Math.max(0, scroll - 1); dirty = true; break
      case "pageup": scroll += 5; dirty = true; break
      case "pagedown": scroll = Math.max(0, scroll - 5); dirty = true; break
      case "ctrl":
        if (pressed.value === "u") { applyComposer({ text: "", cursor: 0 }, true); dirty = true; refreshPalette() }
        if (pressed.value === "k") { applyComposer(deleteRange(composerState(), "toEnd"), true); dirty = true; refreshPalette() }
        if (pressed.value === "z") {
          const back = composerHistory.undo(composerState())
          if (back) { applyComposer(back); dirty = true; refreshPalette() }
        }
        if (pressed.value === "y") {
          const forward = composerHistory.redo(composerState())
          if (forward) { applyComposer(forward); dirty = true; refreshPalette() }
        }
        if (pressed.value === "l") { applyComposer(selectAll(composerState())); dirty = true }
        if (pressed.value === "w") {
          // Delete the word before the caret. ctrl+u wiping the whole line
          // was the only option, which is a lot to lose to fix one word.
          const before = input.slice(0, cursor)
          const trimmed = before.replace(/\s*\S+\s*$/, "")
          input = trimmed + input.slice(cursor)
          cursor = trimmed.length
          dirty = true
          refreshPalette()
        }
        if (pressed.value === "a") { applyComposer(moveTo(composerState(), { to: 0, select: false })); dirty = true }
        if (pressed.value === "e") { applyComposer(moveTo(composerState(), { to: input.length, select: false })); dirty = true }
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
