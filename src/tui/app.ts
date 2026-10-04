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
import { resolveStartupModel } from "../core/model-selection"
import { isLiveCommand } from "./live-commands"
import { copyText, ctrlCAction, dialogRowAt, insideDialog, readClipboardImage } from "./interaction"
import { allSelections } from "../core/providers"
import { normalizeCommand } from "../core/commands"
import { cliAuthStatus, cliStatuses } from "../core/cli-status"
import { cliHandoff } from "../core/cli-handoff"
import { fetchBalance, balanceRows } from "../core/balance"
import { codexAccount, cachedCodexAccount, accountRows, startCodexLogin } from "../core/codex-account"
import { startCursorLogin } from "../core/cursor-sdk"
import { listCodexSessions, importCodexSession } from "../core/codex-import"
import { openCodexLogin, openCursorLogin } from "../core/open-browser"
import * as Dialogs from "./dialog"
import { changesIn, summarise, countsOf, statusLetter, type Changes } from "../core/changes"
import {
  charAfter,
  charBefore,
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
import { displayWidth, truncateToWidth, padToWidth, padStartToWidth, wrapToWidth as wrapWords } from "./width"
import { renderMarkdown } from "./markdown"
import {
  paletteFor,
  renderPalette,
  setFileCache,
  setConnectedProviders,
  slashRange,
  type PaletteItem,
} from "./palette"
import { findMention, expandMentions, droppedMentions } from "../core/mention"
import { History, describe as describeCheckpoint, nothingToDo } from "../core/undo"
import * as settingsStore from "../core/settings"
import {
  loadMedia,
  saveMedia,
  withValue,
  requireMediaSetting,
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
import { localChatMessages, runAgent, type Attachment, type Message } from "../core/agent"
import { COMMANDS, isCommand, runCommand } from "../core/commands"
import * as sessions from "../core/sessions"
import { normaliseActivity, recordActivity } from "../core/session-activity"
import {
  usage,
  shouldCompact,
  planCompaction,
  applyCompaction,
  addSpend,
  priceOf,
  formatSpend,
  formatContext,
  type Spend,
} from "../core/context"
import { marker, counts, type Todo } from "../core/todo"
import { Permissions, DECISIONS, MODES, nextMode, askedFor, refusalLabel, decisionHints, type Decision, type PermissionMode } from "../core/permission"
import { McpManager } from "../core/mcp"
import { SubagentManager, type SubagentEvent } from "../core/subagents"
import { customCommands, invocationItems, resolveInvocation } from "../core/invocations"
import { listSkills, skillIndex } from "../core/skills"
import { setInvocations } from "./palette"
import { systemPrompt } from "../core/system-prompt"
import { configPath, checkpointEvery } from "../core/config"

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

const launchModel = parseLaunch(argv).model
if (launchModel && !resolveSelection(launchModel)) process.stderr.write("Checking requested model " + launchModel + "…\n")
const launched = await resolveStartupModel(launchModel)
if (!launched) {
  process.stderr.write("No such available model: " + launchModel + ". Check provider sign-in and the model picker.\n")
  process.exit(1)
}
let selection: Selection = launched
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
const SYSTEM: Message = { role: "system", content: systemPrompt("terminal") }

let messages: Message[] = [SYSTEM]
const contextUsage = () => usage(
  selection.provider.local && !selection.provider.localTools ? localChatMessages(messages) : messages,
  selection.model.contextWindow,
)
/**
 * `call` is the model's tool-call id on a tool row, so a result lands on the
 * row that asked for it. Rows used to be matched by being last, which stopped
 * being true once reads in a turn started overlapping.
 */
type Entry = {
  kind: "user" | "agent" | "tool" | "thinking"
  text: string
  call?: string
  state?: "running" | "done" | "failed"
  /** Who wrote an answer. Every answer used to take the current model's name, so switching relabelled the past. */
  by?: string
}
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

/**
 * /boost. Subagents cost a second conversation's tokens and most tasks do not
 * need them, so the model is not offered them at all unless asked: bare /boost
 * switches them on for the session, /boost <request> for that one request.
 */
let boost = false
let boostOnce = false

/**
 * Background subagents the model starts with the task tool. They work under
 * this conversation's model and permissions, read when each starts; their tool
 * calls show in the transcript under the agent's name, and their spend counts.
 */
const subagents = new SubagentManager(
  () => ({
    provider: selection.provider,
    modelId: selection.model.id,
    apiKey: key ?? "",
    root: process.cwd(),
    where: "terminal",
    contextWindow: selection.model.contextWindow,
    permissions,
    history: edits,
    mcp,
    instructions: skillIndex(listSkills(process.cwd())),
    effort: effortFor(selection.model, settings.effort),
  }),
  (event) => onSubagent(event),
)

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
/** Clipboard pictures waiting to ride with the next message. Shown, so they never sneak in unseen. */
let pendingImages: Attachment[] = []

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
let session = sessions.create(selection.provider.id, selection.model.id)
let resumeModelMissing = false

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
let status = key !== undefined ? "" : "no key for " + selection.provider.label + " - /connect " + selection.provider.id

/** A question waiting on an answer. `cover` is what "Allow for this session" would approve, in words. */
let pending: { tool: string; detail: string; cover: string; from?: string; resolve: (d: Decision) => void } | undefined
/** Questions that arrived while another was on screen - a subagent can ask while the main agent is waiting on one. */
const waitingAsks: NonNullable<typeof pending>[] = []
/** Which answer is highlighted. Starts on "allow once", the least committal. */
let pendingChoice = 0

function cancelPending() {
  const asks = pending ? [pending, ...waitingAsks] : [...waitingAsks]
  pending = undefined
  waitingAsks.length = 0
  pendingChoice = 0
  for (const ask of asks) ask.resolve("reject")
  render()
}

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
  (tool, detail, cover, from) => {
    if (turn?.signal.aborted) return Promise.resolve<Decision>("reject")
    return new Promise<Decision>((resolve) => {
      const ask = { tool, detail, cover, from, resolve }
      if (pending) waitingAsks.push(ask)
      else {
        pending = ask
        pendingChoice = 0
      }
      render()
    })
  },
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

/**
 * The composer's visible rows on screen, for mapping mouse coordinates to
 * text. Content starts after the "  | " gutter, so screen column 5 is offset
 * zero; columns are clamped into the row, wide characters approximately.
 */
let composerMap: { first: number; rows: string[]; before: number } | undefined
/** Whether the mouse has dragged since the press: a clean release is a caret move. */
let dragged = false

function composerOffset(col: number, row: number): number | undefined {
  const map = composerMap
  if (!map || !input) return undefined
  const index = row - map.first
  if (index < 0 || index >= map.rows.length) return undefined
  const line = map.rows[index]!
  const into = Math.max(0, Math.min(col - 5, line.length))
  let at = map.before
  for (let i = 0; i < index; i++) at += map.rows[i]!.length
  return Math.max(0, Math.min(at + into, input.length))
}

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
  // A command picked mid-prompt replaces its own word, the way a mention
  // does: the rest of the sentence has to survive being completed.
  if (value.startsWith("/")) {
    const range = slashRange(input, cursor)
    if (range && range.start > 0) {
      input = input.slice(0, range.start) + value + " " + input.slice(range.end)
      cursor = range.start + value.length + 1
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
  if (findMention(input, cursor)) {
    void refreshFileCache().then((changed) => {
      if (!changed || secret || !findMention(input, cursor)) return
      refreshPalette()
      render()
    })
  }
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
/** How wide the side panel is, when a wide terminal shows one. */
const RAIL_WIDTH = 34
/** The narrowest terminal that shows it; below this every column is the transcript. */
const RAIL_MIN_COLS = 150
let toolbarRow = 0
let toolbarTargets: { from: number; to: number; command: string }[] = []
/** The floating back-to-latest pill, when one is drawn: its screen row and span. */
let latestPill: { row: number; from: number; to: number } | undefined
function render() {
  const { cols, rows } = size()
  // With the side panel showing, the transcript gets the columns left of it -
  // wrapping to the full width and cutting at the panel lost the right side,
  // which is where your own messages sit.
  const railShown = cols >= RAIL_MIN_COLS
  const main = railShown ? cols - RAIL_WIDTH - 1 : cols
  const width = Math.max(20, main - 6)
  const lines: string[] = []

  if (transcript.length === 0) {
    const wide = main >= WORDMARK_WIDTH + 4
    const art = wide ? WORDMARK : [COMPACT]
    const gutter = (main - (wide ? WORDMARK_WIDTH : COMPACT.length)) / 2
    lines.push("")
    for (const row of art) lines.push(theme.goblin + centre(row, gutter) + ansi.reset)
    lines.push("")
    lines.push(theme.gold + centre("your local AI goblin for code, images and agents", (main - 47) / 2) + ansi.reset)
  } else {
    for (const entry of transcript) {
      if (entry.kind === "tool") {
        for (const [i, line] of entry.text.split(String.fromCharCode(10)).entries()) {
          // Every row used to start with "x", so a read that worked looked like one that failed.
          const mark = entry.state === "done" ? "✓" : entry.state === "failed" ? "✗" : entry.state === "running" ? "…" : "·"
          lines.push(theme.muted + (i === 0 ? "  " + mark + " " : "    ") + line.slice(0, width) + ansi.reset)
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
      if (isUser) {
        // Yours on the right, the goblin's on the left, as in a chat.
        const room = Math.max(10, width - 6)
        const wrapped = entry.text.split(String.fromCharCode(10)).flatMap((line) => wrapWords(line, Math.floor(room * 0.75)))
        const block = Math.max(3, ...wrapped.map((line) => displayWidth(line)))
        const indent = " ".repeat(Math.max(2, width - block - 4))
        lines.push(accent + indent + padStartToWidth("you", block + 2) + ansi.reset)
        for (const line of wrapped) lines.push(indent + theme.text + padToWidth(line, block) + ansi.reset + accent + " |" + ansi.reset)
        lines.push("")
        continue
      }
      lines.push(accent + "  " + (entry.by ?? selection.provider.label.toLowerCase()) + ansi.reset)
      for (const line of renderMarkdown(entry.text, width)) lines.push(accent + "  | " + ansi.reset + line)
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
    4 + promptHeight + paletteLines.length + planLines.length + overlayHeight + pendingHeight
  const room = Math.max(1, rows - composerHeight - 1)

  const maxScroll = Math.max(0, lines.length - room)
  scroll = Math.min(scroll, maxScroll)
  const cut = lines.length - room - scroll
  const body = lines.length > room ? lines.slice(Math.max(0, cut), Math.max(0, cut) + room) : lines
  while (body.length < room) body.push("")

  // A side panel on wide terminals: session, spend and servers at a glance,
  // the way the original shows them beside the conversation. Narrow screens
  // keep every column for the transcript - it is only ever display, never
  // clickable, so nothing below has to learn new coordinates.
  if (railShown) {
    const rail = railLines(room)
    for (let index = 0; index < body.length; index++) {
      body[index] =
        padToWidth(truncateToWidth(body[index]!, main), main) +
        theme.border + "│" + ansi.reset + padToWidth(truncateToWidth(rail[index] ?? "", RAIL_WIDTH), RAIL_WIDTH)
    }
  }

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
  if (pending && !input) {
    // The box names what is being asked and what "for this session" would
    // cover. It used to say only "allow this?", with the command down in the
    // input line, and the session hint said "calls like this" - which told you
    // nothing once an approval covered one command rather than the whole tool.
    const asked = askedFor(pending.tool, pending.detail).replace(/\s+/g, " ")
    const title = " " + (pending.from ? pending.from + " subagent: " : "") + "allow " + pending.tool + ": " + asked + "?"
    const worded = decisionHints(pending.tool, pending.cover)
    const hints = DECISIONS.map((d) => worded[d.id])
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
  if (pending && !input) {
    shown =
      theme.gold + pending.tool + ansi.reset + " " +
      dim + askedFor(pending.tool, pending.detail).replace(/\s+/g, " ").slice(0, Math.max(10, visibleInput - 24)) + ansi.reset
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
  // Scrolled up a way: a floating way back down, Claude-style, only while
  // scrolled - a button that is always there teaches nobody anything.
  latestPill = undefined
  if (scroll > 3) {
    const label = "[ ↓ back to latest ]"
    const from = Math.max(0, Math.floor((cols - displayWidth(label)) / 2))
    body.push(" ".repeat(from) + theme.gold + label + ansi.reset)
    latestPill = { row: body.length, from: from + 1, to: from + label.length }
  }
  // A queued prompt stays on screen in dimmer text, Claude-style: clearing
  // the composer without showing what is waiting reads as the prompt being
  // eaten, and Ctrl+S with an empty composer then looks broken.
  if (queued && !secret) {
    const preview = queued.replace(/\s+/g, " ")
    body.push(dim + "  queued: " + truncateToWidth(preview, Math.max(0, cols - 14)) + ansi.reset)
  }
  // Clipboard pictures waiting to ride along. Named on screen so nothing
  // reaches the model unseen; a new conversation lets them go.
  if (pendingImages.length && !secret) {
    body.push(dim + "  images: " + truncateToWidth(pendingImages.map((image) => image.name).join(", "), Math.max(0, cols - 14)) + ansi.reset)
  }
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

  // Where the composer's visible rows sit, so a mouse press or drag maps to
  // a text offset. Recorded per frame because wrapping and scroll move them.
  composerMap =
    input && composerRows.length
      ? { first: body.length - composerRows.length + 1, rows: [...composerRows], before: rowsBefore }
      : undefined
  body.push(theme.border + "  " + "-".repeat(inner) + ansi.reset)

  const context = contextUsage()
  const modeTag =
    (permissions.mode === "ask" ? "" : "  [" + MODES.find((entry) => entry.id === permissions.mode)!.label.toLowerCase() + "]") +
    (permissions.planning ? "  [planning]" : "") +
    (boost || boostOnce ? "  [boost]" : "") +
    (subagents.running().length ? "  [" + subagents.running().length + " subagent" + (subagents.running().length === 1 ? "" : "s") + " running]" : "")
  const spendTag = spend.input + spend.output > 0 ? "  " + formatSpend(spend) : ""
  // Usage stays on the bar even while a status is showing: a transient
  // message used to replace the model, context and spend readout entirely,
  // so "no key" also hid what you were connected to.
  const usage = selection.provider.label + " . " + selection.model.id + (context.limit > 0 ? "  ~" + context.percent + "% ctx" : "  ctx window unknown") + spendTag
  const left = status ? status + "   " + usage : modeTag.trim() + (modeTag ? "  " : "") + usage
  const right = dialog
    ? "up/down move . enter chooses . esc closes"
    : streaming
    ? (queued ? "queued . shift+tab mode . esc stops" : "enter queues . ctrl+s sends now . esc stops")
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
        : "shift+tab mode . ctrl+c copy/clear/quit"
  // A long status gives way to the key hints rather than pushing them off the
  // edge: "mode: Full access - never ask - only the rules..." ran into them.
  const statusRoom = Math.max(10, cols - displayWidth(right) - 4)
  const plain = "  " + (displayWidth(left) > statusRoom - 2 ? truncateToWidth(left, statusRoom - 3) + "…" : left)
  const padded = padToWidth(plain, Math.max(displayWidth(plain) + 1, cols - displayWidth(right) - 2))
  body.push(dim + padded + ansi.reset + theme.muted + right + ansi.reset)
  toolbarRow = body.length + 1
  toolbarTargets = []
  let toolbar = "  "
  for (const item of [
    { label: "[+]", command: "attach" }, { label: "[Model]", command: "model" },
    { label: "[Settings]", command: "settings" }, { label: "[Sessions]", command: "sessions" },
    { label: "[Usage]", command: "usage" },
  ]) {
    const from = displayWidth(toolbar) + 1
    if (from + item.label.length > cols) break
    toolbar += item.label + " "
    toolbarTargets.push({ from, to: from + item.label.length - 1, command: item.command })
  }
  body.push(theme.goblin + toolbar + ansi.reset)

  // Clamp on display width: CJK and emoji are two columns, so a line that
  // looks short by .length can still overflow and wrap.
  const clamped = body.map((line) => (displayWidth(line) <= cols ? line : truncateToWidth(line, cols - 1) + ansi.reset))

  // rule, prompt lines, rule, status - so the caret's row counts back past
  // however many lines the prompt currently takes.
  const promptLines = Math.max(1, composerRows.length)
  caretAt =
    caretOffset === undefined
      ? undefined
      : { row: body.length - promptLines - 2 + caretLine, col: 5 + caretOffset }

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
      // The age tells apart conversations that share a title, as the web sidebar does.
      hint: (entry.id === session.id ? "open . " : "") + sessions.ago(entry.updated),
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
/** A subagent's progress, into the transcript under its name. */
function onSubagent(event: SubagentEvent) {
  session.activity ??= normaliseActivity(undefined)
  recordActivity(session.activity, event)
  const rowFor = (id: string) => [...transcript].reverse().find((entry) => entry.kind === "tool" && entry.call === id)
  if (event.type === "subagent_start") {
    transcript.push({ kind: "tool", text: event.agent + " subagent started: " + event.description })
  } else if (event.type === "subagent_end") {
    const first = event.result.split(String.fromCharCode(10)).find((line) => line.trim()) ?? ""
    transcript.push({
      kind: "tool",
      text: event.agent + " subagent " + (event.status === "done" ? "finished" : event.status) + ": " + first.slice(0, 90),
    })
  } else {
    const inner = event.event
    const id = event.task + ":" + ("id" in inner ? inner.id : "")
    if (inner.type === "tool_start") {
      transcript.push({ kind: "tool", call: id, text: "  " + event.agent + " > " + inner.name + " " + inner.args.slice(0, 50) })
    } else if (inner.type === "tool_denied") {
      const row = rowFor(id)
      if (row) row.text += "  (" + refusalLabel(inner) + ")"
    } else if (inner.type === "tool_end") {
      const row = rowFor(id)
      if (row) row.text += "  ->  " + (inner.result.split(String.fromCharCode(10))[0] ?? "").slice(0, 50)
    } else if (inner.type === "spend") {
      spend = addSpend(spend, { input: inner.input, output: inner.output, dollars: priceOf(inner, selection.model.price) })
    }
  }
  render()
}

/**
 * What /status says about autonomy checkpoints: the configured window, or off.
 * Read fresh like the rules, so editing codegoblin.jsonc shows up immediately.
 */
function checkpointStatus(): string {
  const every = checkpointEvery()
  if (every <= 0) return "off"
  return "ask every " + every + " tool calls" + (permissions.checkpointsOff ? "  (off for this session)" : "")
}

/** The focused spend readout: tokens, cost, context - not session config. */
function usageRows(): [string, string][] {
  const context = contextUsage()
  return [
    ["context", formatContext(context)],
    ["tokens", spend.input.toLocaleString() + " input / " + spend.output.toLocaleString() + " output"],
    ["cost", spend.dollars === undefined ? "unknown / subscription; not zero" : formatSpend(spend)],
    ["subscription quota", "Codex: /account; others not wired"],
  ]
}

/** Keep the composer responsive; don't let a late result replace another popup. */
function openUsage(provider = selection.provider.id, accountOnly = false) {
  const view = { title: accountOnly ? "Provider balance" : "Usage (context is estimated)", rows: [
    ...(accountOnly ? [] : usageRows()),
    ["provider balance", "checking " + provider + "…"],
  ] as [string, string][] }
  overlay = view
  void fetchBalance(provider, apiKey(provider)).then((snapshot) => {
    if (overlay !== view) return
    view.rows = [...(accountOnly ? [] : view.rows.slice(0, -1)), ...balanceRows(snapshot)]
    render()
  })
}

let accountRequest = 0
let codexLogin: Awaited<ReturnType<typeof startCodexLogin>> | undefined
let cursorLogin: Awaited<ReturnType<typeof startCursorLogin>> | undefined

function accountDialog(rows: [string, string][]) {
  return Dialogs.open("codex-account", "Codex account / subscription quotas", [
    { label: "Refresh quotas", value: "refresh" },
    { label: "Sign in through official CLI", value: "login" },
    ...rows.map(([label, value]) => ({ label: label + ": " + value, value: "info" })),
  ], { size: "large", footer: "up/down scroll . enter refresh/sign-in . esc closes" })
}

function openAccount() {
  const request = ++accountRequest
  dialog = accountDialog([["status", "Checking official CLI…"]])
  void (async () => {
    const cached = await cachedCodexAccount()
    if (request !== accountRequest || dialog?.kind !== "codex-account") return
    if (cached) { dialog = accountDialog([["refresh", "checking…"], ...accountRows(cached)]); render() }
    const snapshot = await codexAccount()
    if (request !== accountRequest || dialog?.kind !== "codex-account") return
    dialog = accountDialog(accountRows(snapshot))
    render()
  })()
}

function openLogin(source: "codex" | "cursor" = "codex") {
  dialog = Dialogs.open(source + "-login-start", source === "cursor" ? "Cursor SDK / user-plan sign-in" : "Official Codex sign-in", [
    { label: "Start official browser sign-in", value: "start" },
    { label: "Cancel", value: "cancel" },
    { label: source === "cursor" ? "SDK login is separate from Cursor CLI login" : "Signing in changes the official CLI's shared account", inert: true },
    { label: source === "cursor" ? "Creates a named SDK key billed to your Cursor plan" : "No token or password is copied into CG-Next", inert: true },
    ...(source === "cursor" ? [{ label: "Key stored in this CG profile; native SDK tools disabled", inert: true }, { label: "Replaces this profile's SDK sign-in on completion", inert: true }, { label: "For an existing key: /connect cursor-api", inert: true }] : []),
  ], { footer: "enter chooses . esc closes", size: "large" })
}

async function beginLogin(source: "codex" | "cursor" = "codex") {
  if (source === "cursor") await cursorLogin?.cancel()
  if (source === "codex") await codexLogin?.cancel()
  const title = source === "cursor" ? "Cursor SDK / user-plan sign-in" : "Official Codex sign-in"
  const view = Dialogs.open(source + "-login", title, [{ label: "Starting official sign-in…", inert: true }])
  dialog = view
  status = "starting official " + source + " sign-in…"
  render()
  try {
    const login = await (source === "cursor" ? startCursorLogin() : startCodexLogin())
    if (dialog !== view) { await login.cancel(); return }
    if (source === "cursor") cursorLogin = login
    if (source === "codex") codexLogin = login
    dialog = Dialogs.open(source + "-login", title, [
      { label: "Open official sign-in in browser", value: "open" },
      { label: source === "cursor" ? "Check sign-in / models" : "Check sign-in / quotas", value: "check" },
      { label: "Cancel sign-in", value: "cancel" },
      { label: source === "cursor" ? "Creates a profile-local SDK key; expires in 5 minutes" : "Uses the official CLI's shared sign-in; expires in 5 minutes", inert: true },
      { label: source === "cursor" ? "Billed to your user plan; native SDK tools disabled" : "No token or password is copied into CG-Next", inert: true },
      ...(source === "cursor" ? [{ label: "Cancel stops pending login; a completed key stays stored", inert: true }] : []),
    ], { footer: "enter chooses . esc cancels", size: "large" })
  } catch { status = source === "cursor" ? "Could not start Cursor SDK sign-in; check SDK compatibility" : "Could not start Codex sign-in; run codex login" }
  render()
}

async function openImport(cursor?: string) {
  const view = Dialogs.open("codex-import", "Import a Codex text conversation", [{ label: "Reading this project's conversations…", inert: true }])
  dialog = view
  status = "reading this project's Codex conversation list…"
  render()
  try {
    const result = await listCodexSessions(process.cwd(), cursor)
    if (dialog !== view) return
    dialog = Dialogs.open("codex-import", "Import a Codex text conversation (new copy)", [
      ...result.sessions.map((entry) => ({ label: entry.title, hint: (entry.updatedAt === undefined ? "" : new Date(entry.updatedAt * 1000).toLocaleString() + " · ") + entry.id.slice(-8), value: entry.id })),
      ...(result.next ? [{ label: "More conversations…", value: "page:" + result.next }] : []),
      ...(!result.sessions.length ? [{ label: "No Codex conversations for this project", inert: true }] : []),
    ], { size: "large", footer: "enter selects . confirmation before copying . esc closes" })
    status = "Choose a conversation; source stays unchanged"
  } catch { if (dialog === view) status = "Could not list Codex sessions; check CLI compatibility" }
  render()
}

function confirmImport(id: string, title: string) {
  dialog = Dialogs.open("codex-import-confirm", "Copy selected Codex conversation?", [
    { label: "Copy as a new text conversation", value: id },
    { label: "Cancel", value: "cancel" },
    { label: title, inert: true },
    { label: "Source ID ends in " + id.slice(-8), inert: true },
    { label: "Native tools, images, reasoning and hidden prompts omitted", inert: true },
    { label: "Source untouched; current conversation not replaced", inert: true },
    { label: "Continuing sends copied text to your selected model", inert: true },
  ], { size: "large", footer: "enter confirms . esc cancels" })
}

/** Session, spend and servers beside the transcript on wide terminals. */
function railLines(height: number): string[] {
  const context = contextUsage()
  const every = checkpointEvery()
  const filled = Math.max(0, Math.min(10, Math.round(context.percent / 10)))
  const barTone = context.percent >= 90 ? theme.error : context.percent >= 70 ? theme.gold : theme.text
  const bar = barTone + "█".repeat(filled) + "░".repeat(10 - filled) + ansi.reset
  const servers = mcp.statuses()
  const rows: [string, string][] = [
    ["session", session.title],
    ["model", selection.provider.label + " " + selection.model.label],
    ["context", context.limit > 0 ? bar + " " + context.percent + "%" : formatContext(context)],
    ["tokens", spend.input.toLocaleString() + " in / " + spend.output.toLocaleString() + " out"],
    ["cost", spend.dollars === undefined ? "unknown" : formatSpend(spend)],
    ["mode", permissions.mode + (permissions.planning ? " +planning" : "") + (boost || boostOnce ? " +boost" : "")],
    ["checkpoints", every > 0 ? "every " + every + (permissions.checkpointsOff ? " (off)" : "") : "off"],
    ["activity", (session.activity?.items.length || 0) + " recent tool calls"],
    ["mcp", servers.length ? "" : "none yet"],
    ...servers.slice(0, 4).map((server): [string, string] => [
      server.name,
      server.status === "connected" ? server.tools.length + " tools" : server.status,
    ]),
  ]
  const out = [
    theme.gold + padToWidth(" goblin", RAIL_WIDTH) + ansi.reset,
    ...rows.map(([label, value]) => {
      const cell = " " + label + " " + value
      return dim + truncateToWidth(cell, RAIL_WIDTH) + ansi.reset
    }),
  ]
  while (out.length < height) out.push("")
  return out.slice(0, height)
}

/** Ask for approval, Approve for me, Full access - the same three Shift+Tab cycles through. */
function openApprovalsPicker() {
  dialog = Dialogs.open(
    "approvals",
    "How much to ask",
    MODES.map((mode) => ({
      label: (mode.id === permissions.mode ? "• " : "  ") + mode.label,
      hint: mode.hint,
      value: mode.id,
    })),
    { footer: "enter chooses . esc closes . shift+tab cycles", size: "medium" },
  )
}

/** After a planned answer: carry the plan out, keep planning, or stop. */
function openPlanPicker() {
  const mode = MODES.find((entry) => entry.id === permissions.mode)!
  dialog = Dialogs.open(
    "plan",
    "Carry out this plan?",
    [
      { label: "Yes, carry it out", hint: "planning ends, and " + mode.label.toLowerCase() + " applies", value: "go" },
      { label: "Keep planning", hint: "say what to change about the plan", value: "stay" },
      { label: "Stop planning", hint: "planning ends and nothing is sent", value: "stop" },
    ],
    { footer: "enter chooses . esc keeps planning", size: "medium" },
  )
}

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
  const general: Dialogs.DialogRow[] = [
    { label: "Theme", hint: settings.theme, value: "ui:theme" },
    { label: "Show thinking", hint: settings.thinking ? "on" : "off", value: "ui:thinking" },
    { label: "Mouse controls", hint: settings.mouse ? "on (Shift+drag selects)" : "off (terminal selection)", value: "ui:mouse" },
    { label: "Reasoning effort", hint: settings.effort, value: "ui:effort" },
    { label: "Approvals", hint: permissions.mode, value: "ui:approvals" },
  ]
  if (!options.length) {
    // Say why the list is empty - a chat model has no generation settings at
    // all, which is a different answer from a generator we send nothing to.
    const why =
      kindOf(selection.model) === "text"
        ? "a chat model has no generation settings - pick an image, voice or 3D model"
        : "nothing on this model's request can be changed from here"
    return [...general, { label: "  " + why, tone: "muted", inert: true }]
  }
  return [...general, ...options.map((option) => ({
    label: "  " + option.label,
    hint: labelOf(option, valueOf(media, provider, model, option.id), voices),
    value: option.id,
  }))]
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
  if (dialog?.kind === "codex-login" && codexLogin) {
    const login = codexLogin
    codexLogin = undefined
    void login.cancel()
  }
  if (dialog?.kind === "cursor-login" && cursorLogin) {
    const login = cursorLogin
    cursorLogin = undefined
    void login.cancel()
  }
  dialog = undefined
  settingBeing = undefined
}

/** Enter, whatever the dialog happens to be. */
async function chooseInDialog() {
  if (!dialog) return
  const row = Dialogs.selected(dialog)
  if (!row || !row.value) { render(); return }
  if (dialog.kind === "codex-account") {
    if (row.value === "refresh") openAccount()
    if (row.value === "login") await openLogin()
    render(); return
  }
  if (dialog.kind === "cli-login") {
    if (row.value) await copyText(row.value)
    status = "Official sign-in command copied; run it in your own terminal"
    closeDialog()
    render()
    return
  }
  if (dialog.kind === "codex-login-start" || dialog.kind === "cursor-login-start") {
    if (row.value === "start") await beginLogin(dialog.kind === "cursor-login-start" ? "cursor" : "codex")
    if (row.value === "cancel") closeDialog()
    render(); return
  }
  if (dialog.kind === "cursor-login") {
    if (row.value === "open" && cursorLogin) {
      try { await openCursorLogin(cursorLogin.url); status = "Complete SDK sign-in in the browser, then check here" }
      catch { status = "Could not open official Cursor sign-in in the browser" }
    }
    if (row.value === "check") {
      const state = cursorLogin?.status()
      if (state === "pending") status = "Complete the browser sign-in first; this attempt is still pending"
      if (state === "complete") { closeDialog(); refreshConnected(); status = "Cursor SDK signed in; select /model cursor/default" }
      if (state !== "pending" && state !== "complete") status = "Sign-in failed, expired or cancelled; close and retry /login cursor"
    }
    if (row.value === "cancel") closeDialog()
    render(); return
  }
  if (dialog.kind === "codex-login") {
    if (row.value === "open" && codexLogin) {
      try { await openCodexLogin(codexLogin.url); status = "Complete sign-in in your browser, then check sign-in here" }
      catch { status = "Browser could not open; run codex login" }
    }
    if (row.value === "check") {
      if (codexLogin?.status() === "pending") status = "Complete the browser sign-in first; this attempt is still pending"
      else { closeDialog(); openAccount() }
    }
    if (row.value === "cancel") closeDialog()
    render(); return
  }
  if (dialog.kind === "codex-import") {
    if (row.value.startsWith("page:")) { await openImport(row.value.slice(5)); return }
    confirmImport(row.value, row.label)
    render(); return
  }
  if (dialog.kind === "codex-import-confirm") {
    const id = row.value
    closeDialog()
    if (id === "cancel") { status = "Import cancelled; no conversation copied"; render(); return }
    status = "Copying selected text conversation…"
    render()
    try {
      const result = await importCodexSession(id, process.cwd(), selection.provider.id)
      await refreshSessionCache()
      status = "Copied " + result.messages + " messages; use /resume to open the new copy"
    } catch { status = "Import failed; source and current conversation unchanged" }
    render(); return
  }
  if (dialog.kind === "attach") {
    closeDialog()
    if (row.value === "image") {
      status = "reading the clipboard…"
      render()
      try {
        const picture = await readClipboardImage()
        pendingImages.push(picture)
        status = "attached " + picture.name + " - sends with the next message"
      } catch (error) {
        status = error instanceof Error ? error.message : "could not read the clipboard"
      }
      render()
      return
    }
    applyComposer(insertText(composerState(), row.value === "file" ? "@" : "/"), true)
    refreshPalette()
    render()
    return
  }
  if (dialog.kind === "model-picker") {
    const next = resolveSelection(row.value)
    if (next) {
      if (streaming) { queued = "/model " + row.value; status = "model switch queued until this turn ends" }
      else { selection = next; resumeModelMissing = false; key = apiKey(next.provider.id); status = next.provider.label + " " + next.model.label }
    }
    closeDialog(); render(); return
  }

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
    await restoreSession(loaded)
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

  // /help and /skills: the chosen command goes into the prompt, ready for its
  // argument, rather than running with none.
  if (dialog.kind === "invoke") {
    closeDialog()
    input = row.value + " "
    cursor = input.length
    refreshPalette()
    render()
    return
  }

  if (dialog.kind === "approvals") {
    changePermissionMode(row.value as PermissionMode)
    closeDialog()
    render()
    return
  }

  if (dialog.kind === "plan") {
    closeDialog()
    if (row.value === "stay") {
      status = "still planning - say what to change"
      render()
      return
    }
    permissions.planning = false
    if (row.value === "stop") {
      status = "planning off"
      render()
      return
    }
    input = "Go ahead and carry out the plan."
    cursor = input.length
    render()
    void send()
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
    if (row.value.startsWith("ui:")) {
      const action = row.value.slice(3)
      if (action === "theme") openThemePicker()
      if (action === "effort") openEffortPicker()
      if (action === "approvals") openApprovalsPicker()
      if (action === "thinking" || action === "mouse") {
        settings = { ...settings, [action]: !settings[action] }
        void settingsStore.save(settings)
        if (action === "mouse") applyMouse()
        openSettings()
      }
      render(); return
    }
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
    session = sessions.create(selection.provider.id, selection.model.id)
    resumeModelMissing = false
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
      // The age tells apart conversations that share a title, as the web sidebar does.
      hint: (entry.id === session.id ? "open . " : "") + sessions.ago(entry.updated),
      value: entry.id,
    })),
  )
  status = "deleted"
  render()
}

async function send() {
  if (secret) {
    const provider = secret.provider
    const typed = input
    // Cleared before the await, so a slow disk cannot leave it on screen.
    input = ""
    cursor = 0
    secret = undefined
    try {
      await connect(provider, typed)
      refreshConnected()
      // The key this terminal sends is read once at startup and on model
      // switches - storing one without re-reading it left every later prompt
      // answering "no key" for a provider that was just connected.
      if (provider === selection.provider.id) key = apiKey(provider)
      status = "connected " + provider + " - stored in " + storePath()
    } catch (error) {
      status = error instanceof Error ? error.message : "could not store the key"
    }
    render()
    return
  }

  const text = normalizeCommand(input.trim())
  if (!text) return

  // A custom command or a skill reads like a command but is a message: its
  // text is what the model gets, and the line typed is what the transcript shows.
  const invoked = isCommand(text) ? resolveInvocation(text, process.cwd()) : undefined

  if (streaming && (invoked || !isLiveCommand(text))) {
    const replaced = Boolean(queued)
    queued = text
    applyComposer({ text: "", cursor: 0 }, true)
    palette = undefined
    status = replaced
      ? "replaced queued prompt - sending when this turn ends . Ctrl+S sends now"
      : "queued - sending when this turn ends . Ctrl+S sends now"
    render()
    return
  }

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
      session = sessions.create(selection.provider.id, selection.model.id)
      resumeModelMissing = false
      permissions.reset()
      subagents.reset()
      edits.reset()
      pastes = []
      pendingImages = []
      spend = { input: 0, output: 0 }
      overlay = undefined
      status = "new conversation"
    }
    // /help is a picker too. Printed, it was twenty-five lines that stayed in
    // the conversation for good.
    if (result.kind === "message" && text.trim() === "/help") {
      dialog = Dialogs.open(
        "invoke",
        "Commands",
        COMMANDS.map((command) => ({ label: command.name, hint: command.description, value: command.name })),
        { footer: "enter puts it in the prompt . wheel or pgup/pgdn scroll . esc closes", size: "large" },
      )
      render()
      return
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
    if (result.kind === "settings") {
      if (!result.argument) { openSettings(); render(); return }
      const [id, ...parts] = result.argument.split(/\s+/)
      const value = parts.join(" ") || MEDIA_DEFAULT
      try {
        const option = requireMediaSetting(selection.provider.id, selection.model.id, id!, value)
        media = withValue(media, selection.provider.id, selection.model.id, option.id, value)
        await saveMedia(media)
        status = option.label + ": " + labelOf(option, value, voices)
      } catch (error) {
        status = error instanceof Error ? error.message : "Could not save setting"
      }
      render(); return
    }
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
    if (result.kind === "boost") {
      if (!result.text) {
        boost = !boost
        status = boost ? "boost on - the model can hand work to subagents" : "boost off"
        render()
        return
      }
      boostOnce = true
      input = result.text
      cursor = input.length
      render()
      void send()
      return
    }
    if (result.kind === "approvals") {
      openApprovalsPicker()
      render()
      return
    }
    if (result.kind === "plan") {
      if (!result.text) {
        permissions.planning = !permissions.planning
        status = permissions.planning ? "planning on - nothing changes until you agree a plan" : "planning off"
        render()
        return
      }
      // The request goes out as an ordinary message, with planning on.
      permissions.planning = true
      input = result.text
      cursor = input.length
      render()
      void send()
      return
    }
    if (result.kind === "skills") {
      // A picker, like every other list. Printed into the transcript it was
      // ninety lines that stayed in the conversation for good and pushed
      // everything else off the screen.
      const skills = listSkills(process.cwd())
      const commands = customCommands(process.cwd())
      if (!skills.length && !commands.length) {
        status = "no skills or custom commands yet - a skill is a folder with a SKILL.md in ~/.claude/skills"
      } else {
        const heading = (label: string): Dialogs.DialogRow => ({ label, tone: "heading", inert: true })
        dialog = Dialogs.open(
          "invoke",
          skills.length + " skills, " + commands.length + " custom commands",
          [
            ...(commands.length ? [heading("custom commands")] : []),
            ...[...commands]
              .sort((a, b) => a.name.localeCompare(b.name))
              .map((command) => ({ label: "/" + command.name, hint: command.scope + (command.description ? " - " + command.description : ""), value: "/" + command.name })),
            ...(skills.length ? [heading("skills")] : []),
            ...[...skills]
              .sort((a, b) => a.name.localeCompare(b.name))
              .map((skill) => ({
                label: "/" + skill.name,
                hint: skill.scope + (skill.modelInvocable ? "" : ", only you can start it") + (skill.userInvocable ? "" : ", only the model can start it"),
                value: "/" + skill.name,
              })),
          ],
          { footer: "enter puts it in the prompt . wheel or pgup/pgdn scroll . esc closes", size: "large" },
        )
      }
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
      const cli = selection.provider.cli ? await cliAuthStatus(selection.provider.id) : undefined
      const context = contextUsage()
      const approved = permissions.summary()
      const rows: [string, string][] = [
        ["model", selection.provider.label + " " + selection.model.label],
        ["session", session.title + "  (" + messages.length + " messages)"],
        ["context", formatContext(context)],
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
        ["checkpoints", checkpointStatus()],
        ["undo", edits.canUndo() ? "available" : "nothing to take back"],
        ["working in", process.cwd()],
      ]
      overlay = { title: "status", rows }
      if (cli) rows.push(["CLI", cli.detail])
    }
    // /usage is the spend readout, not session config: tokens, cost and
    // context on their own, the way the [Usage] button shows them.
    if (result.kind === "usage") {
      openUsage()
    }
    if (result.kind === "account") { openAccount(); render(); return }
    if (result.kind === "login") { openLogin(result.source); render(); return }
    if (result.kind === "cli-login") {
      const handoff = cliHandoff(result.source)
      dialog = Dialogs.open("cli-login", handoff.label + " sign-in handoff", [
        { label: "Copy official sign-in command", value: handoff.command },
        { label: handoff.command, inert: true },
        { label: "Completing sign-in can change the shared CLI account", inert: true },
        { label: "Run in your terminal; official CLI opens the browser", inert: true },
        { label: "CG-Next does not read or copy passwords/tokens", inert: true },
        { label: "Check afterward: " + handoff.statusCommand, inert: true },
        { label: "Closing does not cancel an externally started login", inert: true },
      ])
      render(); return
    }
    if (result.kind === "import") {
      if (kindOf(selection.model) !== "text") { status = "Select a text model before importing"; render(); return }
      if (result.id) {
        confirmImport(result.id, "Selected Codex conversation")
        render(); return
      }
      await openImport(); return
    }
    if (result.kind === "balance") {
      openUsage(result.provider || selection.provider.id, true)
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
        resumeModelMissing = false
        key = apiKey(selection.provider.id)
        status = selection.provider.label + " " + selection.model.label
      }
    }
    if (result.kind === "compact") {
      const window = selection.model.contextWindow
      const plan = planCompaction(messages, window)
      // Says why: the most recent quarter of the window is always kept word for
      // word, so a short conversation has nothing older to summarise.
      if (window <= 0) status = "context window unavailable; history unchanged (CLI transport compaction remains automatic)"
      else if (!plan.summarise.length) status = "nothing to compact yet - the whole conversation still fits in the recent part that is kept as it is"
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
          await restoreSession(loaded)
        }
      }
    }
    render()
    return
  }

  // A generation model has no chat endpoint, so a plain prompt belongs to it
  // rather than to a conversation. Picking one and typing is how you make a
  // picture without remembering a command.
  if (resumeModelMissing) {
    status = "choose /model to continue"
    render()
    return
  }
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

  // Says how to fix it, not only what is wrong - and in the transcript, not
  // only the status bar, where the next status replaced it before it was read.
  if (key === undefined) {
    const missing =
      "No key for " + selection.provider.label + " - add one with /connect " + selection.provider.id +
      " (stored in " + storePath() + "), or set " + envVariable(selection.provider.id) + " and resend."
    status = "no key for " + selection.provider.label + " - /connect " + selection.provider.id + " to add one"
    transcript.push({ kind: "tool", state: "failed", text: missing })
    render()
    return
  }

  input = ""
  cursor = 0
  palette = undefined
  scroll = 0
  history.push(text)
  historyIndex = -1
  session.provider = selection.provider.id
  session.model = selection.model.id
  // Mentions are read here rather than in the agent so the stored message
  // carries the files with it: a resumed conversation keeps its context.
  // What was folded away goes back before anything sees it.
  const whole = invoked ? invoked.content : unfoldPastes(text)
  const mentioned = await expandMentions(whole, process.cwd())
  const seeing = acceptsImages(selection)
  const images = [...mentioned.images, ...pendingImages]
  const pasted = pendingImages.map((image) => image.name)
  pendingImages = []
  messages.push(
    mentioned.files.length || whole !== text || images.length
      ? { role: "user", content: mentioned.content, display: text, images }
      : { role: "user", content: text },
  )
  transcript.push({ kind: "user", text })
  if (mentioned.files.length) transcript.push({ kind: "tool", text: "attached " + mentioned.files.join(", ") })
  if (pasted.length) transcript.push({ kind: "tool", text: "attached " + pasted.join(", ") })
  // Attaching a picture to a model that cannot see one is a mistake worth
  // catching here, where the model is named, rather than leaving it to be
  // inferred from an answer that does not mention the image.
  if (images.length && !seeing) {
    transcript.push({
      kind: "tool",
      text: selection.model.label + " cannot see images - pick a vision model to send " +
        images.map((image) => image.name).join(", "),
    })
  }
  streaming = true
  status = ""
  startSpinner()
  render()

  let current: Entry | undefined
  turn = new AbortController()
  // Every stop path must wake consent, not only the Ctrl+S interrupt path.
  turn.signal.addEventListener("abort", cancelPending, { once: true })
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
      // Offered only with /boost - or while subagents started under it are still out.
      subagents: boost || boostOnce || subagents.running().length ? subagents : undefined,
      effort: effortFor(selection.model, settings.effort),
      signal: turn.signal,
      memory: await memory.recall({ project: process.cwd(), session: session.id }),
      instructions: [skillIndex(listSkills(process.cwd())), mcp.notice()].filter(Boolean).join(String.fromCharCode(10, 10)) || undefined,
    })) {
      session.activity ??= normaliseActivity(undefined)
      recordActivity(session.activity, event)
      if (event.type === "thinking") {
        if (!current || current.kind !== "thinking") {
          current = { kind: "thinking", text: "" }
          transcript.push(current)
        }
        current.text += event.delta
      }
      if (event.type === "text") {
        if (!current || current.kind !== "agent") {
          current = { kind: "agent", text: "", by: selection.provider.label.toLowerCase() }
          transcript.push(current)
        }
        current.text += event.delta
      }
      if (event.type === "tool_start") {
        current = undefined
        // Summarised as approvals are, so an edit's row names its file before the cut.
        transcript.push({ kind: "tool", call: event.id, text: event.name + " " + askedFor(event.name, event.args).replace(/\s+/g, " ").slice(0, 60), state: "running" })
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
      if (event.type === "output_limit") {
        current = undefined
        transcript.push({ kind: "tool", text: "The model reached its output-token limit. The answer is unfinished; ask it to continue or increase the server's output budget." })
        status = "hit the output limit"
      }
      // An autonomy checkpoint fired: the turn paused to ask whether it may
      // keep going. Either way the transcript says what happened, because a
      // turn that stopped here is unfinished work, not a finished answer.
      if (event.type === "checkpoint") {
        transcript.push({
          kind: "tool",
          text: "paused at the autonomy checkpoint (" + event.toolCalls + " tool calls) - " +
            (event.stopped ? "stopped; ask it to continue" : "continuing"),
        })
        if (event.stopped) status = "stopped at the autonomy checkpoint"
      }
      // Found by call id rather than by being last: several tools can be open
      // at once now, so "the most recent row" is no longer the right one.
      const rowFor = (id: string) =>
        [...transcript].reverse().find((entry) => entry.kind === "tool" && entry.call === id)

      if (event.type === "tool_denied") {
        const row = rowFor(event.id)
        // Whose decision it was: a rule, plan mode, or you. It said "refused"
        // for all three, so a command a rule stopped read as one you declined.
        if (row) {
          row.text += "  (" + refusalLabel(event) + ")"
          row.state = "failed"
        }
      }
      if (event.type === "tool_end") {
        const row = rowFor(event.id)
        if (row) {
          if (row.state !== "failed") row.state = /^(error|stopped)/.test(event.result) ? "failed" : "done"
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
    // A failed request is part of the conversation, not only the status bar,
    // where the next status replaced it. Seen with a real provider: "Insufficient
    // Balance" showed for a moment and then a message simply had no answer.
    if (!turn?.signal.aborted) {
      transcript.push({ kind: "tool", state: "failed", text: error instanceof Error ? error.message.slice(0, 400) : "request failed" })
    }
  } finally {
    streaming = false
    stopSpinner()
    turn = undefined
    edits.commit()
    session.messages = messages
    session.spend = spend
    session.review = edits.reviewState(process.cwd())
    session.activity = normaliseActivity(session.activity, true)
    void sessions.save(session).then(refreshSessionCache).catch(() => {})
    void refreshFileCache(true)

    boostOnce = false

    // A planned answer ends with the choice of what happens next, so agreeing
    // to a plan is one keystroke rather than a sentence.
    const answered = messages.at(-1)
    if (permissions.planning && !queued && status !== "stopped" && answered?.role === "assistant" && answered.content.trim()) {
      openPlanPicker()
    }

    // Anything typed mid-turn goes now, without a keystroke to remind it.
    if (queued) {
      const next = queued
      queued = undefined
      status = "sending now"
      const draft = composerState()
      input = next
      cursor = next.length
      void send()
      if (!isCommand(next)) {
        applyComposer(draft)
        refreshPalette()
        render()
      }
      return
    }
    render()
  }
}

function shutdown() {
  turn?.abort()
  subagents.stopAll()
  out.write("[0m" + ansi.pasteOff + "\x1b[?1002l\x1b[?1006l" + ansi.releaseMouse + ansi.showCursor + ansi.mainScreen)
  // MCP servers started as child processes go with the app, but one that will
  // not close is not allowed to keep the terminal waiting.
  void Promise.race([Promise.all([mcp.close(), codexLogin?.cancel(), cursorLogin?.cancel()]), new Promise((done) => setTimeout(done, 3500))]).finally(() => process.exit(0))
}

async function restoreSession(loaded: sessions.Session) {
  const requested = loaded.model ? loaded.provider + "/" + loaded.model : loaded.provider
  const restored = await resolveStartupModel(requested)
  session = loaded
  spend = loaded.spend ?? { input: 0, output: 0 }
  messages = loaded.messages
  transcript = fromMessages(messages)
  scroll = 0
  edits.reset()
  edits.restoreReview(process.cwd(), loaded.review)
  session.activity = normaliseActivity(loaded.activity, true)
  plan = session.activity.plan
  if (session.activity.items.length) {
    transcript.push({ kind: "tool", text: "Saved activity (latest 12 calls)" })
    transcript.push(...session.activity.items.slice(-12).map(item => ({ kind: "tool" as const, text: item.label + (item.state === "interrupted" ? " · not completed" : ""), state: item.state === "done" ? "done" as const : "failed" as const })))
  }
  if (edits.reviewNotice) transcript.push({ kind: "tool", state: "failed", text: edits.reviewNotice })
  resumeModelMissing = !restored || kindOf(restored.model) !== "text"
  if (resumeModelMissing) transcript.push({ kind: "tool", state: "failed", text: "Saved model unavailable: " + requested + ". Use /model to continue." })
  if (restored && !resumeModelMissing) {
    selection = restored
    key = apiKey(restored.provider.id)
  }
  status = resumeModelMissing ? "choose /model to continue"
    : "resumed: " + loaded.title + (loaded.model ? "" : " (older session: provider default)")
}

async function refreshSessionCache() {
  // Kept as a hook: the picker reads the store directly now, but saving a
  // session still wants somewhere to say so as the list grows other readers.
  await sessions.list(1)
}
void refreshSessionCache()

let filesReadAt = 0
let filesReading: Promise<boolean> | undefined
async function refreshFileCache(force = false): Promise<boolean> {
  if (filesReading) return filesReading
  if (!force && Date.now() - filesReadAt < 1000) return false
  // Share one bounded walk across keystrokes; failed walks keep the useful cache.
  filesReading = globFiles(process.cwd(), "**/*", 4000).then((files) => {
    setFileCache(files)
    filesReadAt = Date.now()
    return true
  }).catch(() => false).finally(() => { filesReading = undefined })
  return filesReading
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
  out.write(settings.mouse ? ansi.takeMouse : "\x1b[?1002l\x1b[?1006l" + ansi.ownMouse)
}

function refreshConnected() {
  setConnectedProviders([...connections().map((item) => item.id), "local"])
  void cliStatuses().then((cli) => {
    setConnectedProviders([...connections().map((item) => item.id), "local", ...Object.keys(cli).filter((id) => cli[id]?.ready)])
  }).catch(() => {})
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

function changePermissionMode(mode: PermissionMode) {
  permissions.mode = mode
  const entry = MODES.find((entry) => entry.id === mode)!
  status = "mode: " + entry.label + " - " + entry.hint
  if (dialog?.kind === "approvals") {
    openApprovalsPicker()
    dialog!.index = MODES.findIndex((entry) => entry.id === mode)
  }
  // A mode change can release queued requests, but never overrides explicit
  // ask/deny rules or planning restrictions.
  const asks = pending ? [pending, ...waitingAsks] : [...waitingAsks]
  waitingAsks.length = 0
  pending = undefined
  pendingChoice = 0
  for (const ask of asks) {
    const verdict = permissions.automaticVerdict(ask.tool, ask.detail)
    if (verdict) ask.resolve(verdict.allowed ? "once" : "reject")
    else if (!pending) pending = ask
    else waitingAsks.push(ask)
  }
}

process.stdin.on("data", (chunk) => {
  let dirty = false

  for (const pressed of readKeys(chunk.toString())) {
    if (pressed.type === "ctrl" && pressed.value === "c") {
      const span = composerSelection(composerState())
      const action = ctrlCAction({ selected: Boolean(span), busy: streaming, draft: Boolean(input), secret: Boolean(secret) })
      if (action === "copy" && span) {
        void copyText(input.slice(span.from, span.to)).then(() => { status = "selection copied"; render() }).catch((error) => { status = error.message; render() })
      }
      if (action === "stop") { turn?.abort(); subagents.stopAll(); status = "stopped" }
      if (action === "clear") { applyComposer({ text: "", cursor: 0 }, true); status = "draft cleared; Ctrl+C again quits" }
      if (action === "quit") return shutdown()
      render(); continue
    }
    // Ctrl+S sends the draft now instead of queueing it: the running turn is
    // stopped and the turn-end below picks the draft up as soon as the abort
    // lands. A waiting permission question is refused so the abort is never
    // stuck behind a prompt nobody will answer. With nothing typed but a
    // prompt already queued, it fast-forwards that one instead of ignoring
    // the key.
    if (pressed.type === "ctrl" && pressed.value === "s") {
      if (streaming && !secret && !dialog && (input.trim() || queued)) {
        if (input.trim()) {
          queued = input
          input = ""
          cursor = 0
          palette = undefined
        }
        turn?.abort()
        subagents.stopAll()
        status = "interrupted - sending now"
        render(); continue
      }
      if (streaming && !secret && !dialog) status = "nothing to send - type a prompt first, Enter queues, Ctrl+S sends now"
      render()
      continue
    }
    // A press or drag in the composer starts or extends a mouse selection,
    // the way shift+arrows do from the keyboard. Backspace deletes it, typing
    // replaces it, Ctrl+C copies it; Escape below drops it.
    if (pressed.type === "press" || pressed.type === "drag") {
      if (!dialog && !secret) {
        const hit = composerOffset(pressed.col, pressed.row)
        if (hit !== undefined) {
          if (pressed.type === "press") {
            applyComposer({ text: input, cursor: hit, anchor: hit })
            dragged = false
          } else {
            applyComposer({ text: input, cursor: hit, anchor })
            dragged = true
          }
          refreshPalette()
          render()
        }
      }
      continue
    }
    if (pressed.type === "click") {
      if (dialog) {
        const screen = size()
        const height = Dialogs.dialogHeight(dialog, screen.rows)
        const width = Dialogs.dialogWidth(dialog, screen.cols)
        const boxHeight = Dialogs.box(dialog, screen.cols, screen.rows).length
        const index = dialogRowAt({ ...pressed, ...screen, width, height, boxHeight, first: Dialogs.firstVisible(dialog, height) })
        // A click outside the box goes back to the conversation: a popup you
        // can only leave through its own rows traps the mouse. A click on the
        // box itself - title, border, a heading - leaves it open.
        if (index !== undefined && !dialog.rows[index]?.inert) { dialog.index = index; void chooseInDialog() }
        else if (!insideDialog({ ...pressed, ...screen, width, boxHeight })) closeDialog()
        render(); continue
      }
      // The floating pill goes back to the latest output.
      if (latestPill && pressed.row === latestPill.row && pressed.col >= latestPill.from && pressed.col <= latestPill.to) {
        scroll = 0
        render(); continue
      }
      // A release in the composer ends the gesture: dragged keeps its
      // selection for backspace or copy, a clean click is a caret move.
      if (!secret) {
        const hit = composerOffset(pressed.col, pressed.row)
        if (hit !== undefined) {
          if (!dragged) applyComposer({ text: input, cursor: hit })
          dragged = false
          refreshPalette()
          render(); continue
        }
      }
      // Clicks elsewhere drop a keyboard or mouse selection.
      anchor = undefined
      dragged = false
      if (pressed.row !== toolbarRow || secret) { render(); continue }
      const target = toolbarTargets.find((item) => pressed.col >= item.from && pressed.col <= item.to)?.command
      if (target === "attach") dialog = Dialogs.open("attach", "Add to the prompt", [{ label: "Mention a project file", value: "file" }, { label: "Paste image from clipboard", value: "image" }, { label: "Run a slash command", value: "command" }])
      if (target === "model") dialog = Dialogs.open("model-picker", "Choose model", allSelections().map((s) => ({ label: s.provider.label + " " + s.model.label, value: s.provider.id + "/" + s.model.id })), { size: "large" })
      if (target === "settings") openSettings()
      if (target === "sessions") {
        if (streaming) { status = "sessions cannot change during a turn; use /resume to queue" }
        else void openSessions().then(render)
      }
      if (target === "usage") openUsage()
      render(); continue
    }
    if (pressed.type === "shifttab") {
      changePermissionMode(nextMode(permissions.mode))
      render()
      continue
    }

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

    if (pending && !input && !palette && !(pressed.type === "char" && pressed.value === "/")) {
      const answer = (decision: Decision) => {
        const ask = pending!
        pending = waitingAsks.shift()
        pendingChoice = 0
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


    // While the palette is open it owns up, down, tab and escape.
    if (palette) {
      if (pressed.type === "up") { paletteIndex = Math.max(0, paletteIndex - 1); dirty = true; continue }
      if (pressed.type === "down") { paletteIndex = Math.min(palette.length - 1, paletteIndex + 1); dirty = true; continue }
      if (pressed.type === "escape") { palette = undefined; render(); continue }
      // The wheel moves through the list. It used to fall through and scroll
      // the conversation behind the menu, which looked like the menu was stuck.
      if (pressed.type === "wheelup") { paletteIndex = Math.max(0, paletteIndex - 1); dirty = true; continue }
      if (pressed.type === "wheeldown") { paletteIndex = Math.min(palette.length - 1, paletteIndex + 1); dirty = true; continue }
      if (pressed.type === "pageup") { paletteIndex = Math.max(0, paletteIndex - 8); dirty = true; continue }
      if (pressed.type === "pagedown") { paletteIndex = Math.min(palette.length - 1, paletteIndex + 8); dirty = true; continue }
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

        // A command picked mid-prompt is text being written, not a command
        // being run: it completes its own word and the sentence stays.
        if (chosen.startsWith("/") && !input.startsWith("/")) {
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
      case "paste": {
        // Newlines inside a paste are content. A paste that is only one
        // short line is just typing, and goes in as it is - unless it is a
        // file dropped from Explorer, which becomes a mention instead.
        const dropped = droppedMentions(pressed.value.replace(/\r\n?/g, String.fromCharCode(10)), process.cwd())
        const value = dropped ?? foldPaste(pressed.value.replace(/\r\n?/g, String.fromCharCode(10)))
        applyComposer(insertText(composerState(), value), true)
        dirty = true
        break
      }
      case "escape":
        if (secret) { secret = undefined; input = ""; cursor = 0; anchor = undefined; status = "cancelled"; dirty = true; break }
        // Escape drops a selection before it clears the line, so losing a
        // highlight does not also lose everything you had written.
        if (anchor !== undefined) { anchor = undefined; dragged = false; dirty = true; break }
        if (input) { applyComposer({ text: "", cursor: 0 }, true); dirty = true }
        else if (streaming) {
          turn?.abort()
          subagents.stopAll()
          status = "stopped"
          dirty = true
        }
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
        const to = pressed.ctrl ? wordStart(input, cursor) : charBefore(input, cursor)
        applyComposer(moveTo(state, { to, select: Boolean(pressed.shift) }))
        dirty = true
        break
      }
      case "right": {
        const state = composerState()
        const to = pressed.ctrl ? wordEnd(input, cursor) : charAfter(input, cursor)
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
        applyComposer(insertText(composerState(), pressed.value), true)
        dirty = true
        refreshPalette()
        break
    }
  }

  if (dirty) { refreshPalette(); render() }
})

process.on("SIGINT", shutdown)
