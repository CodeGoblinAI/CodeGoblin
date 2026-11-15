/**
 * CodeGoblin TUI.
 *
 *   bun run tui
 *   bun run tui -- --model zai/glm-5.3
 *
 * Raw ANSI, no framework.
 */
import { ansi, theme, dim, invert, noInvert, applyTheme as paintTheme } from "./ansi"
import { APPEARANCES, effectiveTheme, terminalLooksLight } from "../core/theme"
import { LEADER_DEFAULTS, loadKeymap, type LeaderAction } from "./keybinds"
import os from "node:os"
import { homeLayout, pickTip, setHomeTip } from "./wordmark"
import { toolDetail, type DetailLine } from "./tool-detail"
import { THEMES } from "../core/theme"
import { EFFORTS } from "../core/settings"
import { createKeyReader } from "./keys"
import { parseLaunch } from "./args"
import { resolveStartupModel } from "../core/model-selection"
import { isLiveCommand } from "./live-commands"
import { footerHeight } from "./layout"
import { copyText, ctrlCAction, dialogRowAt, insideDialog, readClipboardImage } from "./interaction"
import { activateCatalog, refreshCatalog, refreshExperientialModels, refreshLiveModels, refreshRefuselessModels, selectionsByKind, selectionsOfKind } from "../core/providers"
import { apiKey as storedKey } from "../core/auth"

// Model lists that change often are read live once, without holding up startup.
void refreshExperientialModels()
void refreshRefuselessModels()
void refreshLiveModels(storedKey)
// models.dev: every provider for /connect, and the ones with a key in the picker.
void refreshCatalog(storedKey).then(() => { refreshConnected(); render() })
import { isLocalChat } from "../core/local-provider"
import { localCommand } from "../core/local-command"
import { runTypedCommand, typedCommand } from "../core/user-shell"
import { LOCAL_CATALOG, currentDownload, downloadModel, gb as gbOf, isInstalled, lastDownload, progressText } from "../core/local-downloads"
import { ownedModelsDir } from "../core/local-runtime"
import { normalizeCommand } from "../core/commands"
import { cliAuthStatus, cliStatuses } from "../core/cli-status"
import { cliHandoff } from "../core/cli-handoff"
import { fetchBalance, balanceRows } from "../core/balance"
import { codexAccount, cachedCodexAccount, accountRows, startCodexLogin } from "../core/codex-account"
import { subscriptionAccount, cachedSubscriptionAccount, subscriptionRows } from "../core/subscription-account"
import { startCursorLogin } from "../core/cursor-sdk"
import { IMPORTERS, type ImportSource } from "../core/conversation-import"
import { openCodexLogin, openCursorLogin } from "../core/open-browser"
import * as Dialogs from "./dialog"
import { VOICE_LANGUAGES, VOICE_NEEDS, cancelVoiceSetup, prepareVoice, stopVoice, transcribe, voiceProblem, voiceState, warmVoice } from "../core/voice"
import { canRecord, record, stopRecorder, warmRecorder, type Recording } from "../core/voice-record"
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
import { displayWidth, truncateMiddle, truncateToWidth, padToWidth, padStartToWidth, wrapToWidth as wrapWords } from "./width"
import { renderMarkdown } from "./markdown"
import {
  paletteFor,
  renderPalette,
  setFileCache,
  setConnectedProviders,
  slashRange,
  type PaletteItem,
} from "./palette"
import { findMention, expandMentions, droppedMentions, droppedImages, imageTypeOf } from "../core/mention"
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
import { exportSession, sessionMarkdown } from "../core/export"
import { runMedia, describeMedia, type MediaKind } from "../core/media"
import * as memory from "../core/memory"
import { globFiles } from "../core/search"
import { CONNECTABLE, KIND_LABEL, defaultSelection, resolveSelection, acceptsImages, effortFor, effortHint, effortLevels, effortProblem, takesEffort, type Selection, kindOf } from "../core/providers"
import { apiKey, connect, disconnect, connections, storePath, envVariable } from "../core/auth"
import { compactConversation, localChatMessages, runAgent, type Attachment, type Message } from "../core/agent"
import { idleCompaction, idleNote } from "../core/idle-compact"
import type { AskUser, Question } from "../core/question"
import { COMMANDS, isCommand, runCommand } from "../core/commands"
import * as sessions from "../core/sessions"
import { normaliseActivity, recordActivity } from "../core/session-activity"
import {
  usage,
  shouldCompact, formatInput, costOf,
  planCompaction, boundSummaryInput,
  applyCompaction,
  addSpend,
  priceOf,
  formatSpend,
  formatContext,
  type Spend,
} from "../core/context"
import { marker, counts, type Todo } from "../core/todo"
import { Permissions, decisionsFor, MODES, nextMode, askedFor, toolLabel, refusalLabel, decisionHints, type Decision, type PermissionMode } from "../core/permission"
import { McpManager, withoutServers } from "../core/mcp"
import { browserStatus, switchBrowser } from "../core/browser"
import { SubagentManager, listAgents, selectedAgent, agentSelection, type SubagentEvent } from "../core/subagents"
import { customCommands, invocationItems, resolveInvocation } from "../core/invocations"
import { listSkills, skillIndex } from "../core/skills"
import { setAgents, setInvocations, setModelLists, setRecentCommands, isListedCommand } from "./palette"
import { loadRecentCommands, noteCommandUse } from "../core/command-rank"
import { agentMention } from "../core/subagents"
import { FAVOURITES, RECENT, markRecent, pickerRows, toggleFavourite } from "../core/favourites"
import { formatterStatus } from "../core/formatter"
import { systemPrompt } from "../core/system-prompt"
import { configPath, checkpointEvery, spendLimitPerPrompt, idleCompactMin } from "../core/config"

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
let agentName: string | undefined
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
  isLocalChat(selection.provider, selection.model.id) ? localChatMessages(messages) : messages,
  selection.model.contextWindow,
)
/**
 * `call` is the model's tool-call id on a tool row, so a result lands on the
 * row that asked for it. Rows used to be matched by being last, which stopped
 * being true once reads in a turn started overlapping.
 */
type Entry = {
  kind: "user" | "agent" | "tool" | "thinking" | "worked"
  text: string
  call?: string
  state?: "running" | "done" | "failed"
  /** Who wrote an answer. Every answer used to take the current model's name, so switching relabelled the past. */
  by?: string
  /** Thinking only: when the first and the latest reasoning arrived, for "thought for Ns". */
  started?: number
  last?: number
  /** When it was written, for /timestamps. */
  at?: number
  /** Tool rows: what came of the call, drawn under it - a command's output, what a file now says. */
  detail?: DetailLine[]
}
/** Each running call's arguments, so its row can show what it did once it ends. */
const callArgs = new Map<string, string>()
/** /fold: every answer drawn as its first lines. A view, not a setting. */
let foldAnswers = false
/** /timestamps: when each message was written, beside who wrote it. */
let showTimes = false
/** /timeline: the entry to bring to the top of the screen on the next frame. */
let jumpTo: Entry | undefined
const FOLDED_LINES = 3
/** Ctrl+O: finished thinking shown in full rather than folded to one line. A view, not a setting. */
let expandThinking = false
let transcript: Entry[] = []
/** Readable messages of a resumed conversation left out of the drawn transcript. */
let hiddenEarlier = 0
/** Whether compaction has archived older messages of this conversation. */
let historyArchived = false
/**
 * Transcript rows drawn at most. Every frame walks what is drawn, so a long
 * conversation is drawn from its recent end and /export has the rest.
 */
const TRANSCRIPT_WINDOW = sessions.DISPLAY_MESSAGES
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
    mcp: withoutServers(mcp, session.mcpOff ?? []),
    instructions: skillIndex(listSkills(process.cwd())),
    effort: effortFor(selection.model, currentEffort()),
  }),
  (event) => onSubagent(event),
)

// Custom commands and skills join the slash picker. Read once here for the
// picker; a message reads them fresh, so one written mid-session still runs.
setInvocations(invocationItems(process.cwd()))
setRecentCommands(loadRecentCommands())
setAgents(listAgents(process.cwd()))

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

/** A paste of four lines or more folds to a token (sessions.pasteToken); below that it just reads as typing. */
function foldPaste(text: string): string {
  if (!settings.pasteSummary) return text
  const token = sessions.pasteToken(text, pastes)
  if (!token) return text
  pastes.push({ token, text, lines: text.split(String.fromCharCode(10)).length })
  return token
}

/** Put the real text back, for the model rather than the screen. */
function unfoldPastes(text: string): string {
  return sessions.unfoldPastes(text, pastes)
}
let settings = settingsStore.defaults()
/** The theme drawn: the chosen one, swapped for its light or dark counterpart when Appearance says so. */
function applyTheme(name: string) {
  paintTheme(effectiveTheme(name, settings.appearance, terminalLooksLight()))
}
function applyLook() {
  applyTheme(settings.theme)
  render()
}
const currentEffort = () => settingsStore.effortForModel(settings, selection.provider.id + "/" + selection.model.id)
/** How generation should come out. Separate file, separate lifetime. */
let media: MediaSettings = {}
/** The account's voices, once fetched, so a voice id can be shown by name. */
let voices: MediaChoice[] = []
let session = sessions.create(selection.provider.id, selection.model.id)
let resumeModelMissing = false

let input = ""
let cursor = 0
let scroll = 0
/** Last frame's transcript height and window, for keeping the view still and for paging. */
let drawnLines = 0
let lastRoom = 10
let lastTop = 0
/** Where each of your messages starts in the transcript, for ctrl+up and ctrl+down. */
let userStarts: number[] = []
/** Output arrived below while scrolled up. */
let newBelow = false
/** Esc pressed once during a turn: a second press before this time stops it. */
let stopArmedUntil = 0
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
    if (message.role === "user" && message.typed) out.push({ kind: "tool", state: "done", text: (message.display ?? message.content).replace(/^! /, "$ ") })
    else if (message.role === "user") out.push({ kind: "user", text: message.display ?? message.content, at: message.at })
    else if (message.role === "assistant" && message.content) out.push({ kind: "agent", text: message.content, at: message.at })
    if (message.stopped) out.push({ kind: "tool", text: "stopped", state: "failed" })
  }
  return out
}
function spinnerFrame() {
  return SPINNER[spinnerTick % SPINNER.length]!
}

function startSpinner() {
  if (spinnerTimer || !settings.animations) return
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

/**
 * A question from the model (its question tool), waiting on the person.
 *
 * Drawn where approvals are: the options to move through, then "Type your
 * own answer", which hands the composer over until enter sends the words.
 */
type Asking = { question: Question; resolve: (answer: string[] | undefined) => void; picked: Set<number>; typing: boolean }
let asking: Asking | undefined
const waitingQuestions: Asking[] = []
let askingChoice = 0

const askUser: AskUser = (question, signal) =>
  new Promise((resolve) => {
    if (signal?.aborted) return resolve(undefined)
    const entry: Asking = { question, resolve, picked: new Set(), typing: false }
    // A stopped turn takes its question with it.
    signal?.addEventListener("abort", () => settleQuestion(entry, undefined), { once: true })
    if (asking) waitingQuestions.push(entry)
    else { asking = entry; askingChoice = 0 }
    render()
  })

function settleQuestion(entry: Asking, answer: string[] | undefined) {
  if (asking === entry) { asking = waitingQuestions.shift(); askingChoice = 0 }
  else {
    const at = waitingQuestions.indexOf(entry)
    if (at < 0) return
    waitingQuestions.splice(at, 1)
  }
  entry.resolve(answer)
  // The answer is on the question's row in the conversation; the status line need not say it again.
  if (answer) status = ""
  render()
}

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
/** Voice input in progress: the microphone is open, or its recording is being turned into text. */
let listening: Listening | undefined
let transcribing = false
/** Which files are expanded in the diff viewer. */
const diffOpen = new Set<string>()
/** The last diff computed, so expanding a file does not recompute it. */
let lastChanges: Changes | undefined
/** Which setting is having its value chosen. */
let settingBeing: string | undefined
/** A conversation being renamed from the list: the prompt holds its name until Enter. */
let renaming: { id: string } | undefined
/** Files this conversation has changed, for the side panel; refreshed after each tool call. */
let railChanges: { path: string; added: number; removed: number }[] = []
async function refreshRailChanges() {
  try { railChanges = (await changesIn(process.cwd(), edits)).files.map((file) => ({ path: file.path, added: file.added, removed: file.removed })) } catch {}
}
/** The generator whose settings are open from Settings > Images/Audio/3D, when it is not the selected model. */
let settingsFor: { provider: string; model: string; label: string } | undefined
let generatorKind: "image" | "audio" | "model3d" = "image"
const settingsTarget = () => settingsFor ?? { provider: selection.provider.id, model: selection.model.id, label: selection.provider.label + " " + selection.model.label }
const MEDIA_SECTIONS: { kind: "image" | "audio" | "model3d"; label: string }[] = [
  { kind: "image", label: "Images" }, { kind: "audio", label: "Audio" }, { kind: "model3d", label: "3D models" },
]
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
/**
 * "~\\proj:main" for the home screen: the folder, with the home folder as ~,
 * and its git branch once that has been read. Reading it runs git, so it is
 * done once in the background and again after /branch.
 */
let homeBranch: string | undefined
function homeWhere(): string {
  const cwd = process.cwd()
  const home = os.homedir()
  const folder = cwd.toLowerCase().startsWith(home.toLowerCase()) ? "~" + cwd.slice(home.length) : cwd
  return folder + (homeBranch ? ":" + homeBranch : "")
}
function readHomeBranch() {
  void import("../core/worktrees").then(({ currentBranch }) => {
    const found = currentBranch(process.cwd())
    if (found === homeBranch) return
    homeBranch = found
    if (transcript.length === 0 && homeDrawn) render()
  }).catch(() => {})
}
let homeDrawn = false

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
  // A key, or a conversation name being edited, is not a command or a mention.
  if (secret || renaming) { palette = undefined; return }
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
/**
 * Each transcript entry's drawn rows, kept until something that changes them
 * does. Every keystroke and stream token repaints the frame; re-wrapping a
 * long conversation each time made typing in a resumed 1,300-message import
 * take most of a second per key. Only the entry being streamed is redrawn.
 */
const drawnRows = new WeakMap<Entry, { key: string; rows: string[] }>()
function entryLines(entry: Entry, width: number): string[] {
  const key = [width, settings.theme, settings.thinking, entry.kind, entry.state ?? "", entry.by ?? selection.provider.label, entry.text.length,
    // Thinking folds once it is finished, and Ctrl+O flips every fold.
    entry.kind === "thinking" ? String(expandThinking) + (entry === transcript.at(-1) && streaming) : "",
    entry.kind === "agent" ? String(foldAnswers) : "", showTimes && entry.at ? sessions.clockTime(entry.at) : "", entry.detail?.length ?? 0].join("|")
  const cached = drawnRows.get(entry)
  if (cached && cached.key === key) return cached.rows
  const rows = drawEntry(entry, width)
  drawnRows.set(entry, { key, rows })
  return rows
}

/** A message typed while the goblin works: drawn as yours, dimmer, marked as waiting. */
function queuedLines(text: string, width: number): string[] {
  const room = Math.max(10, width - 6)
  const wrapped = text.split(String.fromCharCode(10)).flatMap((line) => wrapWords(line, Math.floor(room * 0.75))).slice(0, 6)
  const label = "queued \u00b7 sends when this finishes"
  const block = wrapped.reduce((widest, line) => Math.max(widest, displayWidth(line)), Math.min(displayWidth(label), Math.floor(room * 0.75)))
  const indent = " ".repeat(Math.max(2, width - block - 4))
  return [
    theme.gold + indent + padStartToWidth(truncateToWidth(label, block + 2), block + 2) + ansi.reset,
    ...wrapped.map((line) => indent + dim + padToWidth(line, block) + ansi.reset + theme.gold + " |" + ansi.reset),
    "",
  ]
}

function drawEntry(entry: Entry, width: number): string[] {
  const out: string[] = []
  if (entry.kind === "tool") {
    // Every row used to start with "x", so a read that worked looked like one that failed.
    const mark = entry.state === "done" ? "✓" : entry.state === "failed" ? "✗" : entry.state === "running" ? "…" : "·"
    let first = true
    for (const line of entry.text.split(String.fromCharCode(10))) {
      // Wrapped under its own indent rather than cut: command output such as
      // /local or /skills is mostly paths and sentences, and the end was lost.
      const indent = /^ */.exec(line)![0].slice(0, 12)
      const pieces = wrapWords(line.slice(indent.length), Math.max(10, width - indent.length - 2))
      for (const [index, piece] of pieces.entries()) {
        out.push(theme.muted + (first ? "  " + mark + " " : "    ") + indent + (index ? "  " : "") + piece + ansi.reset)
        first = false
      }
    }
    // Under the row, behind a rule: output is cut at the edge rather than
    // wrapped, so a long line costs one row, not five.
    for (const line of entry.detail ?? []) {
      const colour = line.tone === "add" ? theme.goblin : line.tone === "remove" ? theme.error : dim
      out.push(theme.border + "    \u2502 " + ansi.reset + colour + truncateToWidth(line.text, Math.max(10, width - 6)) + ansi.reset)
    }
    out.push("")
    return out
  }
  // The fork's line under a finished answer: how long it worked, and on what.
  if (entry.kind === "worked") {
    out.push(dim + "  ▣ " + entry.text + ansi.reset)
    out.push("")
    return out
  }
  if (entry.kind === "thinking") {
    // Hiding reasoning is a view, not a filter on what is collected -
    // turning it back on should show what was said while it was off.
    if (!settings.thinking) return out
    // Finished reasoning folds to one line, the way the fork showed it: the
    // answer is what matters, and a page of "the user said hi" pushed it off
    // screen. Live reasoning still shows its latest lines, so progress is visible.
    const done = entry !== transcript.at(-1) || !streaming
    if (done && !expandThinking) {
      const seconds = entry.started && entry.last ? Math.max(0.1, (entry.last - entry.started) / 1000) : undefined
      out.push(dim + "  ◆ thought" + (seconds ? " for " + seconds.toFixed(1) + "s" : "") + " · ctrl+o expands" + ansi.reset)
      out.push("")
      return out
    }
    out.push(dim + "  thinking" + (done ? " · ctrl+o folds" : "...") + ansi.reset)
    for (const line of entry.text.split(String.fromCharCode(10)).slice(done ? 0 : -6)) {
      out.push(dim + "  | " + line.slice(0, width) + ansi.reset)
    }
    out.push("")
    return out
  }
  const isUser = entry.kind === "user"
  const accent = isUser ? theme.gold : theme.goblin
  if (isUser) {
    // Yours on the right, the goblin's on the left, as in a chat.
    const room = Math.max(10, width - 6)
    const wrapped = entry.text.split(String.fromCharCode(10)).flatMap((line) => wrapWords(line, Math.floor(room * 0.75)))
    // A reduce, not Math.max(...spread): a huge pasted message has more lines
    // than a call can take arguments.
    const block = wrapped.reduce((widest, line) => Math.max(widest, displayWidth(line)), 3)
    const indent = " ".repeat(Math.max(2, width - block - 4))
    const who = showTimes && entry.at ? sessions.clockTime(entry.at) + " · you" : "you"
    out.push(accent + indent + padStartToWidth(who, block + 2) + ansi.reset)
    for (const line of wrapped) out.push(indent + theme.text + padToWidth(line, block) + ansi.reset + accent + " |" + ansi.reset)
    out.push("")
    return out
  }
  out.push(accent + "  " + (entry.by ?? selection.provider.label.toLowerCase()) + (showTimes && entry.at ? dim + " · " + sessions.clockTime(entry.at) + ansi.reset : "") + ansi.reset)
  const rendered = renderMarkdown(entry.text, width)
  // /fold keeps the start of each answer; the rest is a line away.
  const shown = foldAnswers && rendered.length > FOLDED_LINES + 1 ? rendered.slice(0, FOLDED_LINES) : rendered
  for (const line of shown) out.push(accent + "  | " + ansi.reset + line)
  if (shown !== rendered) out.push(accent + "  | " + ansi.reset + dim + "… " + (rendered.length - FOLDED_LINES) + " more lines - /fold unfolds" + ansi.reset)
  out.push("")
  return out
}

let toolbarRow = 0
let toolbarTargets: { from: number; to: number; command: string }[] = []
/** The floating back-to-latest pill, when one is drawn: its screen row and span. */
let latestPill: { row: number; from: number; to: number } | undefined
function render() {
  if (!homeDrawn) { homeDrawn = true; readHomeBranch() }
  const { cols, rows } = size()
  // With the side panel showing, the transcript gets the columns left of it -
  // wrapping to the full width and cutting at the panel lost the right side,
  // which is where your own messages sit.
  // Not on the empty conversation: there is nothing in the panel to show yet, and the home screen is centred on the full width.
  const railShown = cols >= RAIL_MIN_COLS && transcript.length > 0
  const main = railShown ? cols - RAIL_WIDTH - 1 : cols
  const width = Math.max(20, main - 6)
  const lines: string[] = []
  /** Where /timeline's chosen message starts, when one was chosen. */
  let jumpLine: number | undefined

  // The empty conversation is drawn once the room above the composer is known.
  if (transcript.length > 0) {
    const drawn = transcript.length > TRANSCRIPT_WINDOW ? transcript.slice(-TRANSCRIPT_WINDOW) : transcript
    const leftOut = hiddenEarlier + transcript.length - drawn.length
    if (leftOut || historyArchived) {
      lines.push(dim + "  " + earlierNotice(leftOut, historyArchived).slice(0, width) + ansi.reset)
      lines.push("")
    }
    const starts: number[] = []
    for (const entry of drawn) {
      if (entry === jumpTo) jumpLine = lines.length
      if (entry.kind === "user") starts.push(lines.length)
      for (const line of entryLines(entry, width)) lines.push(line)
    }
    userStarts = starts
    // What was typed while it worked is your next message, so it is drawn as
    // one - where it will go, marked as waiting - rather than as a note by the box.
    if (queued && !secret) for (const line of queuedLines(queued, width)) lines.push(line)
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

  const promptHeight = input && !secret
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
  const footer = {
    prompt: promptHeight,
    pending: pending && !input ? decisionsFor(pending.tool).length + 3 : !pending && asking && !asking.typing ? asking.question.options.length + 4 + wrapWords(asking.question.question, Math.max(23, cols - 7)).length : 0,
    queued: false,
    images: Boolean(pendingImages.length && !secret),
    scrolled: false,
    notice: Number(streaming && !pending && !asking) + Number(Boolean(status || listening || transcribing)),
  }
  // Editing a wrapped draft during inference still draws all its lines.
  // Reserve those, plus queued/image/latest notices, before the transcript.
  const overlayRows = overlay?.rows.slice(0, Math.max(0, rows - footerHeight(footer) - 5)) ?? []
  if (overlay && overlayRows.length && overlayRows.length < overlay.rows.length) {
    overlayRows.splice(-1, 1, ["more", `${overlay.rows.length - overlayRows.length + 1} rows hidden; resize to see more`])
  }
  const overlayHeight = overlay ? overlayRows.length + 3 : 0
  const paletteBudget = Math.max(0, rows - footerHeight({ ...footer, overlay: overlayHeight }) - 2)
  const paletteLines = palette && !streaming ? renderPalette(palette, paletteIndex, cols, paletteBudget) : []
  const planBudget = Math.max(0, paletteBudget - paletteLines.length)
  if (planLines.length > planBudget) {
    planLines.splice(planBudget)
    if (planLines.length) planLines[planLines.length - 1] = dim + "  plan shortened to fit; resize to see more" + ansi.reset
  }
  const composerHeight = footerHeight({ ...footer, overlay: overlayHeight, palette: paletteLines.length, plan: planLines.length })
  const room = Math.max(1, rows - composerHeight - 1)

  // Reading further up while it writes: the view stays on what was being read,
  // instead of the text sliding away under the eye as each line arrives.
  if (scroll > 0 && drawnLines > 0 && lines.length > drawnLines) { scroll += lines.length - drawnLines; newBelow = true }
  // The same when the space for it changes - the working line going, a popup
  // opening: the top line stays the top line.
  if (scroll > 0 && drawnLines > 0 && room !== lastRoom) scroll = Math.max(0, scroll - (room - lastRoom))
  if (scroll === 0) newBelow = false
  drawnLines = transcript.length ? lines.length : 0
  lastRoom = room
  const maxScroll = Math.max(0, lines.length - room)
  // /timeline: the chosen message at the top of the screen, once.
  if (jumpLine !== undefined) { scroll = Math.max(0, lines.length - room - jumpLine); jumpTo = undefined }
  scroll = Math.min(scroll, maxScroll)
  const cut = lines.length - room - scroll
  lastTop = Math.max(0, cut)
  // The empty conversation puts the composer under the wordmark; what is left of the window goes below it.
  const home = transcript.length === 0
    ? homeLayout(main, room + paletteLines.length + footer.notice, paletteLines.length + footer.notice, homeWhere(), { goblin: theme.goblin, gold: theme.gold, dim, reset: ansi.reset }, footer.notice)
    : undefined
  const body = home ? home.above : lines.length > room ? lines.slice(Math.max(0, cut), Math.max(0, cut) + room) : lines
  if (!home) while (body.length < room) body.push("")
  // Scrolled up: a way back down, on the last line of the conversation, as
  // Claude Code has it - shown from the first line up, and saying when there
  // is new output it has not seen.
  latestPill = undefined
  if (!home && scroll > 0 && body.length) {
    const label = newBelow ? " New output \u00b7 jump to bottom (ctrl+end) \u2193 " : " Jump to bottom (ctrl+end) \u2193 "
    const from = Math.max(0, Math.floor((main - displayWidth(label)) / 2))
    body[body.length - 1] = " ".repeat(from) + theme.text + invert + label + noInvert + ansi.reset
    latestPill = { row: body.length, from: from + 1, to: from + displayWidth(label) }
  }

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
    for (const [label, value] of overlayRows) {
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
  if (!pending && asking && !asking.typing) {
    const entry = asking
    const options = entry.question.options
    const title = " " + entry.question.question
    const rows = [
      ...options.map((option, index) => ({
        label: (index + 1) + ". " + (entry.question.multiple ? (entry.picked.has(index) ? "[x] " : "[ ] ") : "") + option.label,
        hint: option.description ?? "",
      })),
      { label: (options.length + 1) + ". Type your own answer", hint: "" },
    ]
    const count = options.length + 1
    const keys = entry.question.multiple ? "1-" + options.length + " or space picks · enter sends · esc dismisses" : "1-" + count + " or enter picks · esc dismisses"
    const labelWidth = Math.max(...rows.map((row) => displayWidth(row.label))) + 2
    const wanted = Math.max(3 + labelWidth + Math.max(0, ...rows.map((row) => displayWidth(row.hint))), displayWidth(title), displayWidth(keys) + 2) + 1
    const inner = Math.max(24, Math.min(wanted, cols - 6))
    body.push(theme.border + "  ╭" + "─".repeat(inner) + "╮" + ansi.reset)
    // A question longer than the window wraps: in a 44-column terminal it used to be cut mid-word.
    for (const [index, piece] of wrapWords(entry.question.question, inner - 1).entries())
      body.push(theme.border + "  │" + ansi.reset + theme.gold + padToWidth(" " + piece, inner) + ansi.reset + theme.border + "│" + ansi.reset)
    for (const [index, row] of rows.entries()) {
      const active = index === askingChoice
      const marker = active ? theme.goblin + " ❯ " + ansi.reset : "   "
      const label = (active ? theme.text : theme.muted) + padToWidth(row.label, labelWidth) + ansi.reset
      const hint = truncateToWidth(row.hint, Math.max(0, inner - 3 - labelWidth))
      body.push(theme.border + "  │" + ansi.reset + padToWidth(marker + label + dim + hint + ansi.reset, inner) + theme.border + "│" + ansi.reset)
    }
    body.push(theme.border + "  │" + ansi.reset + dim + padToWidth("   " + keys, inner) + ansi.reset + theme.border + "│" + ansi.reset)
    body.push(theme.border + "  ╰" + "─".repeat(inner) + "╯" + ansi.reset)
  }

  if (pending && !input) {
    // The box names what is being asked and what "for this session" would
    // cover. It used to say only "allow this?", with the command down in the
    // input line, and the session hint said "calls like this" - which told you
    // nothing once an approval covered one command rather than the whole tool.
    const asked = askedFor(pending.tool, pending.detail).replace(/\s+/g, " ")
    const title = " " + (pending.from ? pending.from + " subagent: " : "") + "allow " + pending.tool + ": " + asked + "?"
    const worded = decisionHints(pending.tool, pending.cover)
    const choices = decisionsFor(pending.tool)
    const hints = choices.map((d) => worded[d.id])
    // One width for every row, padded after colouring - displayWidth skips
    // escape sequences, so the box lines up whatever colour the text is. As
    // wide as the words need, but never wider than the terminal.
    const labelWidth = Math.max(...choices.map((d) => displayWidth(d.label))) + 2
    const wanted = Math.max(3 + labelWidth + Math.max(...hints.map((hint) => displayWidth(hint))), displayWidth(title)) + 1
    const inner = Math.max(24, Math.min(wanted, cols - 6))

    body.push(theme.border + "  " + "╭" + "─".repeat(inner) + "╮" + ansi.reset)
    body.push(
      theme.border + "  │" + ansi.reset +
        theme.gold + padToWidth(truncateToWidth(title, inner), inner) + ansi.reset +
        theme.border + "│" + ansi.reset,
    )
    for (const [index, choice] of choices.entries()) {
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
  } else if (asking && !pending && !input) {
    caretOffset = 0
    shown = dim + (asking.typing ? "type your answer..." : "pick an answer above") + ansi.reset
  } else if (streaming && !input) {
    caretOffset = 0
    shown = dim + (cols < 60 ? "type to queue a message" : "type to queue a message for when this finishes") + ansi.reset
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

  // Working: said where the eye is, in colour, with how long it has been and
  // how to stop it. It used to be a dim spinner inside the prompt box, which
  // on a blank screen read as nothing happening.
  if (streaming && !pending && !asking) {
    body.push(
      theme.goblin + "  " + spinnerFrame() + " working" + ansi.reset +
        dim + " \u00b7 " + sessions.workedFor(Date.now() - workingSince) + " \u00b7 " + ansi.reset +
        (Date.now() < stopArmedUntil ? theme.gold + "press esc again to stop" : dim + "esc twice to stop") + ansi.reset,
    )
  }
  // What just happened - "switched to ...", "no key for ..." - on a line of
  // its own. Sharing the status line, it pushed the model's name off the end.
  // While recording, this line is the recorder's: a red dot, the seconds, and how to finish.
  const heard = listeningLine()
  if (heard) body.push(truncateToWidth(heard, Math.max(10, cols - 2)) + ansi.reset)
  else if (status) body.push(theme.muted + "  " + truncateToWidth(status, Math.max(10, cols - 4)) + ansi.reset)
  // The box takes the colour of how much it may do without asking, as the
  // fork's does: plain when it asks, gold, red at full access, orange while planning.
  const ruleColour = permissions.planning ? theme.warning : permissions.mode === "full" ? theme.error : permissions.mode === "approve" ? theme.gold : theme.border
  body.push(ruleColour + "  " + "\u2500".repeat(inner) + ansi.reset)
  // A queued prompt stays on screen in dimmer text, Claude-style: clearing
  // the composer without showing what is waiting reads as the prompt being
  // eaten, and Ctrl+S with an empty composer then looks broken.

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
  body.push(ruleColour + "  " + "\u2500".repeat(inner) + ansi.reset)

  const context = contextUsage()
  // How much it will ask before acting is always on show, coloured by how
  // much it is trusted with: it changes what the next prompt can do.
  const modeLabel = permissions.mode === "ask" ? "ask" : permissions.mode === "approve" ? "approve for me" : "full access"
  const modeColour = permissions.mode === "ask" ? theme.muted : permissions.mode === "approve" ? theme.gold : theme.error
  const modeTag =
    (permissions.planning ? "  [planning]" : "") +
    (boost || boostOnce ? "  [boost]" : "") +
    (subagents.running().length ? "  [" + subagents.running().length + " subagent" + (subagents.running().length === 1 ? "" : "s") + " running]" : "")
  // Nothing spent on a model that costs nothing is not worth a column.
  const spendTag = spend.input + spend.output > 0 && !(spend.dollars === 0 && !spend.unpriced) ? "  " + formatSpend(spend) : ""
  // Usage stays on the bar even while a status is showing: a transient
  // message used to replace the model, context and spend readout entirely,
  // so "no key" also hid what you were connected to.
  const usageTail = (context.limit > 0 ? "  ~" + context.percent + "% ctx" : "  ctx window unknown") + spendTag
  const fullName = selection.provider.label + " " + selection.model.label
  let left = fullName + usageTail + modeTag
  const rightFor = (compactHints: boolean) => dialog
    ? compactHints ? "enter · esc close" : "up/down · enter choose · esc close"
    : pending && !input
    ? compactHints ? "enter confirm · esc reject" : "up/down · enter confirm · esc reject"
    : asking && !pending
    ? asking.typing ? "enter answers \u00b7 esc back to the choices" : compactHints ? "number or enter \u00b7 esc" : "up/down \u00b7 number or enter picks \u00b7 esc dismiss"
    : streaming
    ? (queued ? (compactHints ? "esc esc stop" : "queued · esc twice stops") : compactHints ? "enter queue · esc esc stop" : "enter queue · ctrl+s now · esc twice stops")
    : renaming
    ? "enter saves the name · esc cancels"
    : secret
    ? "enter saves · esc cancels · nothing is echoed"
    : overlay
    ? "any key closes"
    : scroll > 0
      ? compactHints ? "ctrl+end bottom" : "pgup/pgdn page \u00b7 ctrl+\u2191\u2193 your messages \u00b7 ctrl+end bottom"
      : palette
        ? compactHints ? "tab completes" : "tab complete · up/down pick"
        : compactHints ? "ctrl+g actions" : "shift+tab mode \u00b7 ctrl+g actions \u00b7 ctrl+c copy/quit"
  // The model, context and cost matter more than key hints: when the long hints would cut the readout
  // short ("$0.0…" on a 120-column window with a long model name), the short hints are used instead.
  const roomBeside = (hints: string) => cols - displayWidth(hints) - 4 - displayWidth(modeLabel) - 3
  const fullHints = rightFor(cols < 75)
  const right = displayWidth(left) > roomBeside(fullHints) - 2 ? rightFor(true) : fullHints
  // A long status gives way to the key hints rather than pushing them off the
  // edge: "mode: Full access - never ask - only the rules..." ran into them.
  const statusRoom = Math.max(10, cols - displayWidth(right) - 4 - displayWidth(modeLabel) - 3)
  // A name too long for the bar loses its provider first, then its middle - never its end, which is where
  // "Fast" and "(free route)" are. The context and cost readout stays whole while there is room for it.
  if (displayWidth(left) > statusRoom - 2) {
    const nameRoom = statusRoom - 2 - displayWidth(usageTail + modeTag)
    const name = displayWidth(selection.model.label) <= nameRoom ? selection.model.label : truncateMiddle(selection.model.label, Math.max(12, nameRoom))
    left = name + usageTail + modeTag
  }
  const plain = (displayWidth(left) > statusRoom - 2 ? truncateToWidth(left, statusRoom - 3) + "\u2026" : left)
  const lead = "  " + modeLabel + " \u00b7 "
  const gap = Math.max(1, cols - displayWidth(right) - 2 - displayWidth(lead) - displayWidth(plain))
  body.push("  " + modeColour + modeLabel + ansi.reset + dim + " \u00b7 " + plain + ansi.reset + " ".repeat(gap) + theme.muted + right + ansi.reset)
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
  body.push(theme.muted + toolbar + ansi.reset)

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
  // Added after the caret and the toolbar were placed, so neither has to know about it.
  const framed = home ? [...clamped, ...home.below] : clamped
  const painted = dialog ? Dialogs.compose(framed, Dialogs.box(dialog, cols, rows), cols, rows) : framed
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
    footer: "enter opens a file · n/p next and previous · q or esc closes",
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
        const tone = line.kind === "add" ? "added" as const : line.kind === "remove" ? "removed" as const : "muted" as const
        // Diff wrapping on: a long line continues under itself instead of being cut at the box's edge.
        const room = Math.max(20, Math.min(size().cols - 6, 88) - 14)
        const pieces = settings.diffWrap && displayWidth(line.text) > room ? wrapWords(line.text, room) : [line.text]
        for (const [index, piece] of pieces.entries()) {
          rows.push({ label: (index ? "        " : "  " + number + " " + sign) + piece, tone, inert: true })
        }
      }
    }
    if (!file.hunks.length) {
      rows.push({ label: "    (no line changes)", tone: "muted", inert: true })
    }
  }
  return rows
}

/** Saved conversations, with the one you are in marked. */
async function openSessions(selectedValue?: string) {
  const saved = await sessions.list(60)
  if (!saved.length) {
    status = "no saved conversations yet"
    return
  }
  dialog = Dialogs.open(
    "sessions",
    "Conversations",
    saved.map((entry) => ({
      label: (entry.id === session.id ? "\u2022 " : "  ") + (entry.pinned ? "\u2605 " : "") + entry.title,
      // The age tells apart conversations that share a title, as the web sidebar does.
      hint: (entry.id === session.id ? "open · " : "") + sessions.ago(entry.updated),
      value: entry.id,
    })),
    { footer: "type to search · enter opens · ctrl+p pins · ctrl+r renames · ctrl+d twice deletes", size: "large", filterable: true, ...(selectedValue ? { selectedValue } : {}) },
  )
}

/**
 * Which key to forget.
 *
 * /disconnect used to demand the provider id typed from memory, and the id is
 * not the label - "zai" is GLM, "google" is Gemini. The list already existed
 * for /connect; this makes it something you can choose from.
 */
function openConnect() {
  const rows: Dialogs.DialogRow[] = []
  const have = new Set(connections().map((item) => item.id))
  const entries = CONNECTABLE.map((entry) => ({ ...entry, connected: have.has(entry.id) }))
  const section = (title: string, list: typeof entries) => {
    if (!list.length) return
    rows.push({ label: title, tone: "heading", inert: true })
    for (const entry of list) rows.push({ label: "  " + entry.label, hint: entry.connected ? "connected \u00b7 enter replaces the key" : entry.about, value: entry.id, search: entry.id + " " + entry.label + " " + entry.about })
  }
  section("Connected", entries.filter((entry) => entry.connected))
  section("Providers", entries.filter((entry) => !entry.connected && !entry.more))
  section("More, from models.dev", entries.filter((entry) => !entry.connected && entry.more))
  dialog = Dialogs.open("connect", "Connect a provider", rows, { size: "large", filterable: true, footer: "type to search \u00b7 enter adds a key \u00b7 esc closes" })
}

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
    { footer: "enter twice removes this key · esc closes", size: "medium" },
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
      spend = addSpend(spend, { input: inner.input, output: inner.output, ...(inner.cached ? { cached: inner.cached } : {}), dollars: costOf(inner, selection.model.price) })
    }
  }
  render()
}

/** What is not drawn and where the whole conversation is. Same words as the web. */
function earlierNotice(hidden: number, archived: boolean): string {
  const parts: string[] = []
  if (hidden) parts.push(hidden.toLocaleString() + " earlier messages aren't shown here")
  if (archived) parts.push((hidden ? "older " : "earlier ") + "history was compacted into a summary for the model")
  return parts.join("; ") + ". /export saves the whole conversation as Markdown."
}

/**
 * What /status says about autonomy checkpoints: the configured window, or off.
 * Read fresh like the rules, so editing codegoblin.jsonc shows up immediately.
 */
function checkpointStatus(): string {
  const every = checkpointEvery()
  const spend = spendLimitPerPrompt()
  const parts = [
    ...(every > 0 ? ["every " + every + " tool calls"] : []),
    ...(spend > 0 ? ["at " + formatSpend({ input: 0, output: 0, dollars: spend }) + " per prompt"] : []),
  ]
  if (!parts.length) return "off"
  return "ask " + parts.join(" and ") + (permissions.checkpointsOff ? "  (off for this session)" : "")
}

/** The focused spend readout: tokens, cost, context - not session config. */
function usageRows(): [string, string][] {
  const context = contextUsage()
  return [
    ["context", formatContext(context)],
    ["tokens", formatInput(spend) + " input / " + spend.output.toLocaleString() + " output"],
    ["cost", spend.dollars === undefined ? "unknown / subscription; not zero" : formatSpend(spend)],
    ["subscription quota", "/account codex, claude or cursor (dashboard)"],
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
let accountSource: "codex" | "claude" | "cursor" = "codex"
let codexLogin: Awaited<ReturnType<typeof startCodexLogin>> | undefined
let cursorLogin: Awaited<ReturnType<typeof startCursorLogin>> | undefined
let mcpLogin: Awaited<ReturnType<McpManager["login"]>> | undefined

function openMcp(selectedValue?: string) {
  const servers = mcp.statuses()
  const off = new Set(session.mcpOff ?? [])
  dialog = Dialogs.open("mcp", "MCP servers", servers.length ? servers.flatMap(server => [
    { label: server.name + ": " + server.status + (off.has(server.name) ? " · off in this conversation" : ""), hint: server.tools.length ? server.tools.length + " tools" : server.error, inert: true },
    { label: (off.has(server.name) ? "Turn on " : "Turn off ") + server.name + " for this conversation", value: "toggle:" + server.name },
    ...(server.oauth ? [{ label: "Sign in to " + server.name, value: server.name }] : []),
  ]) : [{ label: "No servers; add mcp entries in " + configPath(), inert: true }], { footer: "enter turns a server on or off, or opens sign-in · esc closes", size: "large", ...(selectedValue ? { selectedValue } : {}) })
}

/** Switches a server off or on for this conversation only; saved with it. */
function setMcpForSession(server: string, on: boolean) {
  const off = new Set(session.mcpOff ?? [])
  if (on) off.delete(server)
  else off.add(server)
  session.mcpOff = [...off]
  status = (on ? "turned on " : "turned off ") + server + " for this conversation"
  if (messages.some((message) => message.role === "user")) void sessions.save(session).catch(() => {})
}

function openMcpLogin(name: string) {
  dialog = Dialogs.open("mcp-login-start", "Authorize " + name + "?", [
    { label: "Only authorize a remote server you trust.", inert: true },
    { label: "It can read/change what your account grants there.", inert: true },
    { label: "Start registers a public OAuth client; browser asks consent.", inert: true },
    { label: "Tokens stay in this CG profile, not other apps' logins.", inert: true },
    { label: "Cancel stops waiting; revoke completed grants at provider.", inert: true },
    { label: "Start sign-in", value: name },
    { label: "Cancel", value: "ui:cancel" },
  ], { size: "large", footer: "enter chooses · esc cancels" })
}

function accountDialog(rows: [string, string][]) {
  return Dialogs.open("codex-account", (accountSource === "claude" ? "Claude" : accountSource === "cursor" ? "Cursor" : "Codex") + " account / subscription quotas", [
    { label: "Refresh quotas", value: "refresh" },
    { label: accountSource === "cursor" ? "Cursor Spending: https://cursor.com/dashboard (copy)" : "Sign in through official CLI", value: "login" },
    ...rows.map(([label, value]) => ({ label: label + ": " + value, value: "info" })),
  ], { size: "large", footer: "up/down scroll · enter refresh/sign-in · esc closes" })
}

function openAccount(source: "codex" | "claude" | "cursor" = "codex") {
  accountSource = source
  const request = ++accountRequest
  dialog = accountDialog([["status", "Checking official CLI…"]])
  void (async () => {
    const cached = source === "codex" ? await cachedCodexAccount() : await cachedSubscriptionAccount(source)
    if (request !== accountRequest || dialog?.kind !== "codex-account") return
    if (cached) { dialog = accountDialog([["refresh", "checking…"], ...(source === "codex" ? accountRows(cached) : subscriptionRows(cached as Awaited<ReturnType<typeof subscriptionAccount>>))]); render() }
    const snapshot = source === "codex" ? await codexAccount() : await subscriptionAccount(source)
    if (request !== accountRequest || dialog?.kind !== "codex-account") return
    dialog = accountDialog(source === "codex" ? accountRows(snapshot) : subscriptionRows(snapshot as Awaited<ReturnType<typeof subscriptionAccount>>))
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
  ], { footer: "enter chooses · esc closes", size: "large" })
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
    ], { footer: "enter chooses · esc cancels", size: "large" })
  } catch { status = source === "cursor" ? "Could not start Cursor SDK sign-in; check SDK compatibility" : "Could not start Codex sign-in; run codex login" }
  render()
}

/** Which CLI the open import picker and its confirmation are about. */
let importFrom: ImportSource = "codex"

async function openImport(source: ImportSource, cursor?: string) {
  importFrom = source
  const name = IMPORTERS[source].label
  const view = Dialogs.open("codex-import", "Import a " + name + " text conversation", [{ label: "Reading this project's conversations…", inert: true }])
  dialog = view
  status = "reading this project's " + name + " conversation list…"
  render()
  try {
    const result = await IMPORTERS[source].list(process.cwd(), cursor)
    if (dialog !== view) return
    dialog = Dialogs.open("codex-import", "Import a " + name + " text conversation (new copy)", [
      // Titles are often a whole first prompt; capped so the date and id that
      // tell same-named conversations apart are not the part that gets cut.
      ...result.sessions.map((entry) => ({
        label: entry.title.length > 56 ? entry.title.slice(0, 55) + "…" : entry.title,
        hint: (entry.updatedAt === undefined ? "" : new Date(entry.updatedAt * 1000).toLocaleDateString() + " · ") + entry.id.slice(-8),
        value: entry.id,
      })),
      ...(result.next ? [{ label: "More conversations…", value: "page:" + result.next }] : []),
      ...(!result.sessions.length ? [{ label: "No " + name + " conversations for this project", inert: true }] : []),
    ], { size: "large", footer: "enter selects · confirmation before copying · esc closes" })
    status = "Choose a conversation; source stays unchanged"
  } catch { if (dialog === view) status = "Could not list " + name + " sessions; check CLI compatibility" }
  render()
}

function confirmImport(source: ImportSource, id: string, title: string) {
  importFrom = source
  dialog = Dialogs.open("codex-import-confirm", "Copy selected " + IMPORTERS[source].label + " conversation?", [
    { label: "Copy as a new text conversation", value: id },
    { label: "Cancel", value: "cancel" },
    { label: title, inert: true },
    { label: "Source ID ends in " + id.slice(-8), inert: true },
    { label: IMPORTERS[source].omitted, inert: true },
    { label: "Source untouched; current conversation not replaced", inert: true },
    { label: "Continuing sends copied text to your selected model", inert: true },
  ], { size: "large", footer: "enter confirms · esc cancels" })
}

/**
 * A picture from the clipboard, attached to the next message.
 *
 * Reached from the + menu and from Ctrl+V. Windows Terminal keeps Ctrl+V for
 * its own paste, and with only an image on the clipboard that paste arrives
 * empty - so an empty paste means "look for a picture", the way the fork did it.
 */
async function attachClipboardImage(fromPaste = false) {
  status = "reading the clipboard…"
  render()
  try {
    const picture = await readClipboardImage()
    pendingImages.push(picture)
    status = "attached " + picture.name + " - sends with the next message" + (acceptsImages(selection) ? "" : " (this model cannot see images; pick a vision model)")
  } catch (error) {
    // Ctrl+V with nothing pasteable is not worth an error message.
    status = fromPaste ? "nothing to paste - the clipboard has no text or image" : error instanceof Error ? error.message : "could not read the clipboard"
  }
  render()
}

/** The models CG-Next can download, as a list to pick from. */
function openLocalPull() {
  const running = currentDownload()
  dialog = Dialogs.open("local-pull", "Download a local model", LOCAL_CATALOG.map((entry) => ({
    label: `${entry.label} · ${gbOf(entry.bytes)} · ${entry.about}`,
    value: entry.id,
    hint: isInstalled(entry) ? "installed" : running?.entry.id === entry.id ? "downloading" : undefined,
  })), { size: "large", footer: "enter chooses · esc closes · official Qwen files, checked against a pinned SHA-256" })
}

/** Nothing is fetched until this is answered: it says how big, from where, and to where. */
function confirmLocalPull(entry: (typeof LOCAL_CATALOG)[number]) {
  if (isInstalled(entry)) { status = entry.label + " is already installed; pick it under Local models"; return }
  dialog = Dialogs.open("local-pull-confirm", "Download " + entry.label + "?", [
    { label: `Download ${gbOf(entry.bytes)}`, value: entry.id },
    { label: "Cancel", value: "cancel" },
    { label: "From huggingface.co/" + entry.repo, inert: true },
    { label: "To " + ownedModelsDir(), inert: true },
    { label: "Kept only if size and SHA-256 match", inert: true },
    { label: "/local cancel stops it; /local pull resumes it", inert: true },
  ], { size: "large", footer: "enter confirms · esc cancels" })
}

/** Session, spend and servers beside the transcript on wide terminals. */
function railLines(height: number): string[] {
  const context = contextUsage()
  const every = checkpointEvery()
  const spendLimit = spendLimitPerPrompt()
  const filled = Math.max(0, Math.min(10, Math.round(context.percent / 10)))
  const barTone = context.percent >= 90 ? theme.error : context.percent >= 70 ? theme.gold : theme.text
  const bar = barTone + "█".repeat(filled) + "░".repeat(10 - filled) + ansi.reset
  const servers = mcp.statuses()
  const rows: [string, string][] = [
    ["session", session.title],
    ["model", selection.provider.label + " " + selection.model.label],
    ["context", context.limit > 0 ? bar + " " + context.percent + "%" : formatContext(context)],
    ["tokens", formatInput(spend) + " in / " + spend.output.toLocaleString() + " out"],
    ["cost", spend.dollars === undefined ? "unknown" : formatSpend(spend)],
    ["mode", permissions.mode + (permissions.planning ? " +planning" : "") + (boost || boostOnce ? " +boost" : "")],
    ["checkpoints", permissions.checkpointsOff ? "off this session" : [every > 0 ? "every " + every : "", spendLimit > 0 ? formatSpend({ input: 0, output: 0, dollars: spendLimit }) : ""].filter(Boolean).join(" · ") || "off"],
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
  // What this conversation has changed, as the original shows beside the chat. /diff opens them.
  if (railChanges.length) {
    out.push("", theme.gold + padToWidth(" changed files  (/diff)", RAIL_WIDTH) + ansi.reset)
    const room = Math.max(1, height - out.length - 1)
    for (const file of railChanges.slice(0, room)) {
      const counts = (file.added ? "+" + file.added : "") + (file.removed ? " -" + file.removed : "")
      const name = file.path.length > RAIL_WIDTH - counts.length - 3 ? "\u2026" + file.path.slice(-(RAIL_WIDTH - counts.length - 4)) : file.path
      out.push(dim + " " + padToWidth(name, RAIL_WIDTH - counts.length - 2) + ansi.reset + theme.goblin + counts + ansi.reset)
    }
    if (railChanges.length > room) out.push(dim + " \u2026 " + (railChanges.length - room) + " more" + ansi.reset)
  }
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
    { footer: "enter chooses · esc closes · shift+tab cycles", size: "medium" },
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
    { footer: "enter chooses · esc keeps planning", size: "medium" },
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
    { footer: "enter applies · esc closes", size: "medium" },
  )
}

/**
 * How hard the model should think.
 *
 * Says up front whether the model on the picker takes it at all, because
 * "high" on a model that does not reason is a preference with no effect, and
 * finding that out from the status line afterwards is finding it out late.
 */
/** This model's own levels - not a fixed list: "high" on one model is not "high" on another. */
function openEffortPicker() {
  const levels = effortLevels(selection.model)
  const name = selection.provider.label + " " + selection.model.label
  const saved = currentEffort()
  dialog = Dialogs.open(
    "effort",
    levels.length ? "Effort  ·  " + selection.model.label : "Effort  ·  " + name + " takes no effort level",
    (levels.length ? ["auto", ...levels] : ["auto"]).map((level) => ({
      label: (level === saved ? "• " : "  ") + level,
      // Said in words where there is something to say; "sent as reasoning_effort" told nobody anything.
      hint: effortHint(selection.model, level) || undefined,
      value: level,
    })),
    // A level saved for this model that it does not have (left from before) is said, not hidden.
    { footer: (saved !== "auto" && !levels.includes(saved) ? `saved "${saved}" is not one of this model's levels, so nothing is sent · ` : "") + "enter applies · esc closes", size: "medium", selectedValue: saved },
  )
}

/** How generation comes out. A popup, because a settings screen should be one. */
/** Opens Settings; `selectedValue` keeps the cursor on the row just changed. */
function openSettings(selectedValue?: string) {
  dialog = Dialogs.open("settings", "Settings  ·  " + settingsTarget().label, settingsFor ? generatorRows() : settingsRows(), {
    footer: "enter changes this setting · esc closes",
    size: "large",
    ...(selectedValue ? { selectedValue } : {}),
  })
}

function openAgents() {
  dialog = Dialogs.open("agents", "Agent profile · " + (agentName || "default"), [
    { label: "Default", hint: "no profile; keep selected model", value: "ui:default-agent" },
    ...listAgents(process.cwd()).map(agent => ({ label: agent.name, hint: (agent.model || "inherit model") + " · " + agent.description, value: agent.name })),
  ], { footer: "enter chooses · /agents default resets · esc closes", size: "large" })
}

async function chooseAgent(name?: string) {
  try {
    const profile = selectedAgent(name, process.cwd())
    const next = await agentSelection(profile, selection)
    if (kindOf(next.model) !== "text") throw new Error("Choose a text model before selecting an agent")
    selection = next
    key = apiKey(next.provider.id)
    agentName = profile?.name
    resumeModelMissing = false
    status = "agent: " + (agentName || "default") + " · " + selection.provider.id + "/" + selection.model.id
  } catch (error) {
    status = error instanceof Error ? error.message : "Agent selection unavailable"
    transcript.push({ kind: "tool", state: "failed", text: status })
  }
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
    { label: "Appearance", hint: settings.appearance + (settings.appearance === "system" ? " (" + (terminalLooksLight() ? "light" : "dark") + " here)" : ""), value: "ui:appearance" },
    { label: "Paste summary", hint: settings.pasteSummary ? "on - long pastes fold to [Pasted ~N lines]" : "off - pastes go in whole", value: "ui:pasteSummary" },
    { label: "Animations", hint: settings.animations ? "on" : "off - a still marker while working", value: "ui:animations" },
    { label: "Diff wrapping", hint: settings.diffWrap ? "on - long lines wrap" : "off - long lines are cut at the edge", value: "ui:diffWrap" },
    { label: "Reasoning effort", hint: currentEffort() + (currentEffort() === "auto" && selection.model.defaultEffort ? " (" + selection.model.defaultEffort + ")" : ""), value: "ui:effort" },
    { label: "Approvals", hint: permissions.mode, value: "ui:approvals" },
    { label: "Agent profile", hint: agentName || "default", value: "ui:agents" },
  ]
  // Every generator's settings are reachable from here, whichever model is selected.
  for (const section of MEDIA_SECTIONS) {
    const count = selectionsOfKind(section.kind).length
    general.push({ label: section.label, hint: count + (count === 1 ? " model" : " models") + " - each keeps its own settings", value: "ui:media:" + section.kind })
  }
  general.push({ label: "Memory", hint: "what is remembered for this project", value: "ui:memory" })
  general.push({ label: "Voice input", hint: voiceState().ready ? (settings.voiceHold ? "ready - hold space to talk" : "ready - /voice records") : "not set up - speak instead of typing", value: "ui:voice" })
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

/** One generator's settings, opened from Settings > Images / Audio / 3D models. */
function generatorRows(): Dialogs.DialogRow[] {
  const target = settingsTarget()
  const options = optionsForModel(target.provider, target.model)
  if (!options.length) return [{ label: "nothing on this model's request can be changed from here", tone: "muted", inert: true }]
  return options.map((option) => ({ label: option.label, hint: labelOf(option, valueOf(media, target.provider, target.model, option.id), voices), value: option.id }))
}

/** The models of one kind, to pick whose settings to change. */
function openGenerators(kind: "image" | "audio" | "model3d") {
  const section = MEDIA_SECTIONS.find((entry) => entry.kind === kind)!
  generatorKind = kind
  settingsFor = undefined
  const rows: Dialogs.DialogRow[] = selectionsOfKind(kind).map((entry) => {
    const changed = optionsForModel(entry.provider.id, entry.model.id).filter((option) => valueOf(media, entry.provider.id, entry.model.id, option.id) !== MEDIA_DEFAULT).length
    return { label: entry.provider.label + " " + entry.model.label, hint: (apiKey(entry.provider.id) ? "" : "not connected · ") + (changed ? changed + " changed" : "defaults"), value: entry.provider.id + "/" + entry.model.id }
  })
  dialog = Dialogs.open("generators", section.label, rows.length ? rows : [{ label: "no models of this kind yet", tone: "muted", inert: true }], {
    footer: "enter opens a model's settings · type to search · esc closes", size: "large", filterable: true,
  })
}

/** What is remembered for this project: add one, or forget one with two presses. */
async function openMemory() {
  const entries = await memory.list({ project: process.cwd() }).catch(() => [])
  dialog = Dialogs.open("memory", "Memory  ·  told to the model on every turn here", [
    { label: "+ Remember something…", hint: "/memory add ...", value: "ui:add" },
    ...(entries.length ? entries.map((entry) => ({ label: (entry.pinned ? "* " : "") + entry.content, hint: entry.scope === "user" ? "every project" : "this project", value: entry.id }))
      : [{ label: "nothing remembered yet", tone: "muted" as const, inert: true }]),
  ], { footer: "enter on a memory forgets it (twice) · esc closes", size: "large" })
  render()
}

/** The values one setting takes. Replaces the list rather than stacking on it. */
function openSettingValues(id: string) {
  const option = optionById(id)
  if (!option) return
  if (option.dynamic === "voices" && !voicesLoaded) void loadVoices()
  const current = valueOf(media, settingsTarget().provider, settingsTarget().model, option.id)
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

/**
 * The model picker: favourites, then recent models, then everything by
 * section. Headings are rows the cursor skips. Read fresh from disk, so a
 * model starred in the browser shows here too.
 */
function modelPickerRows(): Dialogs.DialogRow[] {
  const current = selection.provider.id + "/" + selection.model.id
  const rows: Dialogs.DialogRow[] = []
  const have = new Set(connections().map((item) => item.id))
  const usable = (s: Selection) => Boolean(s.provider.local || s.provider.runtime || s.provider.cli || have.has(s.provider.id))
  // Chat models sit under their provider, as in the fork, so a row is the model's own name and not
  // "Refuseless DeepSeek V4.1 Flash 1017 Abliterated (free route)" cut short. Providers with a key come first.
  const all = pickerRows(selectionsByKind(), settings).map((row) => {
    const grouped = row.section === KIND_LABEL.text
    return { ...row, grouped, heading: grouped ? row.selection.provider.label + (usable(row.selection) ? "" : "  \u00b7 no key, /connect " + row.selection.provider.id) : row.section }
  })
  const ordered = [
    ...all.filter((row) => row.section === FAVOURITES || row.section === RECENT),
    ...all.filter((row) => row.grouped && usable(row.selection)),
    ...all.filter((row) => !row.grouped && row.section !== FAVOURITES && row.section !== RECENT),
    ...all.filter((row) => row.grouped && !usable(row.selection)),
  ]
  let section = ""
  for (const row of ordered) {
    if (row.heading !== section) {
      section = row.heading
      rows.push({ label: section, tone: "heading", inert: true })
    }
    const s = row.selection
    const id = s.provider.id + "/" + s.model.id
    rows.push({
      label: (row.favourite ? "\u2605 " : "  ") + (row.grouped ? "" : s.provider.label + " ") + s.model.label,
      value: id,
      hint: [id === current ? "current" : "", s.provider.runtime ? "runs here" : "", modelFacts(s)].filter(Boolean).join(" \u00b7 ") || undefined,
      search: id + " " + s.provider.label + " " + s.model.label,
      // Searching drops the provider headings, and "DeepSeek V4.1 Flash" is sold by three providers.
      ...(row.grouped ? { searchLabel: (row.favourite ? "★ " : "  ") + s.provider.label + " · " + s.model.label } : {}),
    })
  }
  return rows
}

/** A model in a few words for the picker: how much it holds, whether it sees, what a million tokens cost. */
function modelFacts(s: Selection): string {
  if (kindOf(s.model) !== "text") return ""
  const size = s.model.contextWindow
  const holds = size >= 1_000_000 ? Math.round(size / 100_000) / 10 + "M" : size >= 1000 ? Math.round(size / 1000) + "K" : ""
  const money = (n: number) => "$" + (n >= 10 ? Math.round(n) : Number(n.toFixed(n < 0.1 ? 3 : 2)))
  const price = s.model.price && s.model.price.input + s.model.price.output > 0 ? money(s.model.price.input) + "/" + money(s.model.price.output) : ""
  return [price, holds, s.model.capabilities?.input?.image ? "sees images" : ""].filter(Boolean).join(" \u00b7 ")
}

function openModelPicker(selectedValue = selection.provider.id + "/" + selection.model.id) {
  dialog = Dialogs.open("model-picker", "Choose model", modelPickerRows(), {
    size: "large",
    selectedValue,
    filterable: true,
    footer: "type to search · enter choose · ctrl+f favourite · $/M tokens in/out",
  })
}

/** /timeline: your messages, newest first; choosing one scrolls it to the top. */
function openTimeline() {
  const drawn = transcript.length > TRANSCRIPT_WINDOW ? transcript.slice(-TRANSCRIPT_WINDOW) : transcript
  const asked = drawn.map((entry, index) => ({ entry, index })).filter(({ entry }) => entry.kind === "user").reverse()
  if (!asked.length) { status = "nothing to jump to yet"; return }
  dialog = Dialogs.open("timeline", "Jump to a message", asked.map(({ entry, index }) => ({
    label: entry.text.replace(/\s+/g, " ").slice(0, 70),
    hint: entry.at ? sessions.clockTime(entry.at) : undefined,
    value: String(transcript.length - drawn.length + index),
  })), { size: "large", footer: "type to search · enter jumps there · esc closes", filterable: true })
}

/**
 * /search: every message in the conversation - yours and the answers - to
 * search as you type, each shown around where it matches; enter goes there.
 * The timeline lists only what you asked; an answer is often what you want
 * back.
 */
function openSearch(query = "") {
  const drawn = transcript.length > TRANSCRIPT_WINDOW ? transcript.slice(-TRANSCRIPT_WINDOW) : transcript
  const messages = drawn.map((entry, index) => ({ entry, index })).filter(({ entry }) => entry.kind === "user" || entry.kind === "agent")
  if (!messages.length) { status = "nothing to search yet"; return }
  dialog = Dialogs.open("search", "Search this conversation", messages.reverse().map(({ entry, index }) => ({
    label: entry.text.replace(/\s+/g, " ").slice(0, 90),
    hint: (entry.kind === "user" ? "you" : "goblin") + (entry.at ? " · " + sessions.clockTime(entry.at) : ""),
    value: String(transcript.length - drawn.length + index),
    search: entry.text,
    snippet: true,
  })), { size: "large", footer: "type to search · enter goes to it · esc closes", filterable: true })
  if (query) dialog = Dialogs.filter(dialog, query)
}

/** Stars or unstars a model; the change is written straight to the shared settings file. */
async function starModel(id: string) {
  try {
    const { favourite, favourites } = await toggleFavourite(id)
    settings = { ...settings, favourites }
    setModelLists(settings)
    status = (favourite ? "\u2605 favourite: " : "no longer a favourite: ") + id
  } catch (error) {
    status = "could not save the favourite: " + (error instanceof Error ? error.message : "unknown")
  }
}

/**
 * F2 and shift+F2: the next or previous recently used model, as in the fork. The order of Recent is left
 * alone while cycling - reordering on every press would bounce between the same two models.
 */
function cycleRecentModel(direction: 1 | -1) {
  if (streaming) { status = "the model can change once this turn ends"; return }
  const current = selection.provider.id + "/" + selection.model.id
  const recent = settings.recents.filter((id) => resolveSelection(id))
  if (recent.filter((id) => id !== current).length === 0) { status = "no other recent model yet - /model picks one"; return }
  const at = recent.indexOf(current)
  const next = resolveSelection(recent[(at + direction + recent.length) % recent.length]!)!
  selection = next
  resumeModelMissing = false
  key = apiKey(next.provider.id)
  status = next.provider.label + " " + next.model.label + "  (F2 for the next recent model)"
}

/** The model just switched to goes to the top of Recent. */
function rememberRecent() {
  const id = selection.provider.id + "/" + selection.model.id
  void markRecent(id).then((recents) => { settings = { ...settings, recents }; setModelLists(settings) })
}

function closeDialog() {
  settingsFor = undefined
  if (dialog?.kind === "mcp-login" && mcpLogin) { mcpLogin.cancel(); mcpLogin = undefined }
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
  if (dialog.kind === "actions") {
    closeDialog()
    if (row.value.startsWith("leader:")) await LEADER_RUN[row.value.slice("leader:".length) as LeaderAction]()
    else await runQuick(row.value)
    render(); return
  }
  if (dialog.kind === "agents") {
    closeDialog()
    await chooseAgent(row.value === "ui:default-agent" ? undefined : row.value)
    render(); return
  }
  if (dialog.kind === "mcp" && row.value.startsWith("toggle:")) {
    const server = row.value.slice("toggle:".length)
    setMcpForSession(server, (session.mcpOff ?? []).includes(server))
    openMcp(row.value); render(); return
  }
  if (dialog.kind === "mcp") { openMcpLogin(row.value); render(); return }
  if (dialog.kind === "mcp-login-start") {
    if (row.value === "ui:cancel") { closeDialog(); render(); return }
    const view = Dialogs.open("mcp-login", "MCP sign-in · " + row.value, [{ label: "Discovering authorization server…", inert: true }], { size: "large" })
    dialog = view; render()
    try {
      const login = await mcp.login(row.value)
      if (dialog !== view) { login.cancel(); return }
      mcpLogin = login
      view.rows = [
        { label: "Copy sign-in URL", value: "copy" },
        { label: "Check sign-in / reconnect", value: "check" },
        { label: "Cancel waiting", value: "cancel" },
        { label: "Paste the URL in your browser and authorize there.", inert: true },
        { label: "Expires in five minutes. Completed grants need provider revoke.", inert: true },
      ]
      view.index = 0
    } catch (error) {
      if (dialog === view) view.rows = [{ label: error instanceof Error ? error.message : "MCP sign-in unavailable", inert: true }]
    }
    render(); return
  }
  if (dialog.kind === "mcp-login") {
    if (row.value === "copy" && mcpLogin) { await copyText(mcpLogin.url); status = "MCP sign-in URL copied; paste it in your browser" }
    if (row.value === "check") {
      const state = mcpLogin?.status()
      if (state === "complete") { closeDialog(); openMcp() }
      else status = state === "pending" || state === "exchanging" ? "Waiting for browser sign-in/token exchange" : "Sign-in failed, expired or cancelled; retry /mcp"
    }
    if (row.value === "cancel") closeDialog()
    render(); return
  }
  if (dialog.kind === "codex-account") {
    if (row.value === "refresh") openAccount(accountSource)
    if (row.value === "login" && accountSource === "codex") await openLogin()
    if (row.value === "login" && accountSource === "claude") {
      closeDialog()
      const handoff = cliHandoff("claude")
      dialog = Dialogs.open("cli-login", handoff.label + " sign-in handoff", [
        {label:"Copy official sign-in command",value:handoff.command},
        {label:handoff.command,inert:true}, {label:handoff.warning,inert:true},
        {label:"Run in your terminal; check afterward: " + handoff.statusCommand,inert:true},
      ], {size:"large",footer:"enter copies command · esc closes"})
    }
    if (row.value === "login" && accountSource === "cursor") { await copyText("https://cursor.com/dashboard"); status="Cursor Spending dashboard URL copied" }
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
    if (row.value.startsWith("page:")) { await openImport(importFrom, row.value.slice(5)); return }
    confirmImport(importFrom, row.value, row.label)
    render(); return
  }
  if (dialog.kind === "local-pull") {
    const entry = LOCAL_CATALOG.find((item) => item.id === row.value)
    closeDialog()
    if (entry && isInstalled(entry)) status = entry.label + " is already installed; pick it under Local models"
    else if (entry) confirmLocalPull(entry)
    render(); return
  }
  if (dialog.kind === "local-pull-confirm") {
    const entry = LOCAL_CATALOG.find((item) => item.id === row.value)
    closeDialog()
    if (!entry) { status = "Download cancelled; nothing was fetched"; render(); return }
    status = "starting the download of " + entry.label + "…"
    void downloadModel(entry, { onProgress: (progress) => { status = progressText(progress); render() } })
      .then((file) => { transcript.push({ kind: "tool", state: "done", text: lastDownload()?.message ?? "downloaded " + file }); status = entry.label + " downloaded and verified" })
      .catch((error: unknown) => { transcript.push({ kind: "tool", state: "failed", text: error instanceof Error ? error.message : String(error) }); status = "download of " + entry.label + " stopped" })
      .finally(render)
    render(); return
  }
  if (dialog.kind === "codex-import-confirm") {
    const id = row.value
    closeDialog()
    if (id === "cancel") { status = "Import cancelled; no conversation copied"; render(); return }
    status = "Copying selected text conversation…"
    render()
    try {
      const result = await IMPORTERS[importFrom].copy(id, process.cwd(), selection.provider.id)
      await refreshSessionCache()
      // With nothing open there is nothing to keep in front of it, so the copy
      // opens - as it does in the browser. A conversation in progress stays put.
      const copy = transcript.length === 0 && !streaming ? await sessions.load(result.id) : undefined
      if (copy) { await restoreSession(copy); status = "Copied " + result.messages + " messages; this is the new copy" }
      else status = "Copied " + result.messages + " messages; use /resume to open the new copy"
    } catch { status = "Import failed; source and current conversation unchanged" }
    render(); return
  }
  if (dialog.kind === "attach") {
    closeDialog()
    if (row.value === "image") {
      await attachClipboardImage()
      return
    }
    applyComposer(insertText(composerState(), row.value === "file" ? "@" : "/"), true)
    refreshPalette()
    render()
    return
  }
  if (dialog.kind === "timeline" || dialog.kind === "search") {
    jumpTo = transcript[Number(row.value)]
    closeDialog(); render(); return
  }
  if (dialog.kind === "model-picker") {
    const next = resolveSelection(row.value)
    if (next) {
      if (streaming) { queued = "/model " + row.value; status = "model switch queued until this turn ends" }
      else {
        selection = next; resumeModelMissing = false; key = apiKey(next.provider.id); status = next.provider.label + " " + next.model.label; rememberRecent()
        // As the fork does: a model with effort levels asks for one the first time it is chosen.
        // Any answer, "auto" included, is remembered for that model, so it asks once.
        if (effortLevels(next.model).length && !(row.value in settings.effortByModel)) { closeDialog(); openEffortPicker(); render(); return }
      }
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

  if (dialog.kind === "connect") {
    closeDialog()
    await runQuick("/connect " + row.value)
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
    settings = settingsStore.withModelEffort(settings, selection.provider.id + "/" + selection.model.id, row.value)
    void settingsStore.save(settings)
    status = "effort: " + row.value + (effortHint(selection.model, row.value) ? " - " + effortHint(selection.model, row.value) : "") + " · " + selection.model.label
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
      if (action === "agents") openAgents()
      if (action.startsWith("media:")) openGenerators(action.slice(6) as "image" | "audio" | "model3d")
      if (action === "memory") void openMemory()
      if (action === "voice") openVoiceSetup()
      if (action === "thinking" || action === "mouse" || action === "pasteSummary" || action === "animations" || action === "diffWrap") {
        settings = { ...settings, [action]: !settings[action] }
        void settingsStore.save(settings)
        if (action === "mouse") applyMouse()
        openSettings(row.value)
      }
      if (action === "appearance") {
        settings = { ...settings, appearance: APPEARANCES[(APPEARANCES.indexOf(settings.appearance) + 1) % APPEARANCES.length]! }
        void settingsStore.save(settings)
        applyLook()
        openSettings(row.value)
      }
      render(); return
    }
    openSettingValues(row.value)
    render()
    return
  }

  if (dialog.kind === "generators") {
    const chosen = selectionsOfKind(generatorKind).find((entry) => entry.provider.id + "/" + entry.model.id === row.value)
    if (chosen) { settingsFor = { provider: chosen.provider.id, model: chosen.model.id, label: chosen.provider.label + " " + chosen.model.label }; openSettings() }
    render()
    return
  }

  if (dialog.kind === "voice") {
    if (row.value === "setup") { closeDialog(); setUpVoice(); return }
    if (row.value === "cancel") { cancelVoiceSetup(); closeDialog(); status = "stopping the download…"; render(); return }
    if (row.value === "record") { closeDialog(); await startListening(false); return }
    if (row.value === "hold") { settings = { ...settings, voiceHold: !settings.voiceHold }; void settingsStore.save(settings); if (settings.voiceHold) warmRecorder(); openVoiceSetup(); render(); return }
    if (row.value === "language") {
      settings = { ...settings, voiceLanguage: VOICE_LANGUAGES[(VOICE_LANGUAGES.indexOf(settings.voiceLanguage as (typeof VOICE_LANGUAGES)[number]) + 1) % VOICE_LANGUAGES.length]! }
      void settingsStore.save(settings); openVoiceSetup(); render(); return
    }
    closeDialog(); render(); return
  }

  if (dialog.kind === "memory") {
    if (row.value === "ui:add") { closeDialog(); input = "/memory add "; cursor = input.length; status = "type what to remember, then Enter"; render(); return }
    // Two presses, as deleting a conversation takes: the row says so in between.
    if (dialog.armed !== row.value) { dialog = { ...dialog, armed: row.value }; render(); return }
    await memory.remove(row.value)
    await openMemory()
    render()
    return
  }

  if (dialog.kind === "setting-value" && settingBeing) {
    media = withValue(media, settingsTarget().provider, settingsTarget().model, settingBeing, row.value)
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

/** ctrl+p in the conversation list: keep this one at the top, or let it go. */
async function pinInDialog() {
  if (!dialog || dialog.kind !== "sessions") return
  const row = Dialogs.selected(dialog)
  if (!row?.value) return
  const pinned = !row.label.includes("\u2605")
  await sessions.pin(row.value, pinned)
  if (row.value === session.id) { if (pinned) session.pinned = true; else delete session.pinned }
  await openSessions(row.value)
  status = pinned ? "pinned - it stays at the top of the list" : "unpinned"
  render()
}

/** ctrl+r in the conversation list: the name goes into the prompt to edit; Enter saves it. */
function renameInDialog() {
  if (!dialog || dialog.kind !== "sessions") return
  const row = Dialogs.selected(dialog)
  if (!row?.value) return
  const title = row.label.replace(/^[\u2022 ]+/, "").replace(/^\u2605 /, "")
  closeDialog()
  renaming = { id: row.value }
  input = title
  cursor = input.length
  status = "edit the name · enter saves · esc cancels"
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
    edits.reset(); railChanges = []
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
      label: (entry.id === session.id ? "\u2022 " : "  ") + (entry.pinned ? "\u2605 " : "") + entry.title,
      // The age tells apart conversations that share a title, as the web sidebar does.
      hint: (entry.id === session.id ? "open · " : "") + sessions.ago(entry.updated),
      value: entry.id,
    })),
  )
  status = "deleted"
  render()
}

/**
 * Idle compaction: once a turn ends, a timer is set for shortly before the
 * provider's cache would expire - only where compacting then saves real money
 * on the next message (core/idle-compact.ts decides, per model). Anything the
 * person does first cancels it; so does a draft in the box, since someone
 * typing is not away.
 */
/** When the turn now running began, for the working line. */
let workingSince = 0
let idleTimer: ReturnType<typeof setTimeout> | undefined
let idleCompacting = false
/** The conversation the timer was set for; a different one when it fires means the person moved on. */
let idleStamp = ""
const idleStampNow = () => session.id + ":" + messages.length
function cancelIdleCompact() {
  clearTimeout(idleTimer)
  idleTimer = undefined
}
function scheduleIdleCompact() {
  cancelIdleCompact()
  const due = idleCompaction({ messages, provider: selection.provider, model: selection.model, min: idleCompactMin() })
  if (!due) return
  idleStamp = idleStampNow()
  idleTimer = setTimeout(() => void runIdleCompact(), due.afterMs)
  // A pending compaction must not keep the app alive after quit.
  idleTimer.unref?.()
}
async function runIdleCompact() {
  idleTimer = undefined
  if (streaming || idleCompacting || dialog || pending || asking || secret || input.trim() || queued || idleStamp !== idleStampNow()) return
  // Decided again now: the model or the conversation may have changed since the timer was set.
  const due = idleCompaction({ messages, provider: selection.provider, model: selection.model, min: idleCompactMin() })
  if (!due) return
  idleCompacting = true
  const working = [...messages]
  const forSession = session.id
  let spent = spend
  try {
    for await (const event of compactConversation({
      provider: selection.provider, modelId: selection.model.id, apiKey: key ?? "", messages: working,
      contextWindow: selection.model.contextWindow, keepWindow: due.keepWindow, strict: true,
      archive: (replaced) => sessions.appendArchive(forSession, replaced),
    })) {
      if (event.type === "spend") spent = addSpend(spent, { input: event.input, output: event.output, ...(event.cached ? { cached: event.cached } : {}), dollars: costOf(event, selection.model.price) })
    }
    // The person came back while it ran, or opened another conversation: theirs stands.
    if (streaming || session.id !== forSession || input.trim()) return
    messages = working
    spend = spent
    historyArchived = true
    session.messages = messages
    session.spend = spend
    transcript.push({ kind: "tool", text: idleNote(due.saving) })
    void sessions.save(session).catch(() => {})
    render()
  } catch {
    // Unattended, so nothing is said and nothing is changed; the next turn simply costs what it costs.
  } finally {
    idleCompacting = false
  }
}

async function send() {
  cancelIdleCompact()
  // The person's own answer to the model's question, not a new prompt.
  if (asking?.typing) {
    const typed = input.trim()
    if (!typed) return
    input = ""
    cursor = 0
    settleQuestion(asking, [typed])
    return
  }
  if (renaming) {
    const { id } = renaming
    const title = input.trim().slice(0, 80)
    renaming = undefined
    input = ""
    cursor = 0
    if (!title) { status = "not renamed"; await openSessions(id); render(); return }
    if (id === session.id) { session.title = title; await sessions.save(session).catch(() => {}) }
    else await sessions.rename(id, title)
    await openSessions(id)
    status = "renamed to " + title
    render()
    return
  }
  if (secret) {
    const provider = secret.provider
    const typed = input
    // Cleared before the await, so a slow disk cannot leave it on screen.
    input = ""
    cursor = 0
    secret = undefined
    try {
      await connect(provider, typed)
      // A models.dev provider joins the picker as soon as it has a key.
      activateCatalog(apiKey)
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
  // Commands and skills used lead the / list next time, here and in the browser.
  for (const word of text.match(/(?:^|\s)\/[^\s/]+/g) ?? []) {
    if (isListedCommand(word.trim())) setRecentCommands(noteCommandUse(word.trim()))
  }
  // What was in the composer when this send began. Resolving an agent profile
  // awaits, and a queued prompt restores the newer draft while that runs - so
  // clearing afterwards must only take away the text being sent, never the
  // draft typed since.
  const sending = input
  const clearSent = () => {
    if (input === sending) { input = ""; cursor = 0 }
  }

  // A custom command or a skill reads like a command but is a message: its
  // text is what the model gets, and the line typed is what the transcript shows.
  const invoked = isCommand(text) ? resolveInvocation(text, process.cwd()) : undefined

  if (streaming && (invoked || !isLiveCommand(text))) {
    const replaced = Boolean(queued)
    queued = text
    applyComposer({ text: "", cursor: 0 }, true)
    palette = undefined
    status = replaced
      // The message itself shows in the conversation, marked as waiting; this says what else can be done with it.
      ? "replaced the queued message · Ctrl+S sends it now"
      : "Ctrl+S sends it now"
    render()
    return
  }

  // `!command` runs it here, as you: no model, nothing asked, deny rules still apply.
  const typed = typedCommand(text)
  if (typed) {
    clearSent()
    palette = undefined
    history.push(text)
    const row: Entry = { kind: "tool", state: "running", text: "$ " + typed }
    transcript.push(row)
    status = "running " + typed.slice(0, 60) + " ... (yours, not the model's)"
    render()
    const run = await runTypedCommand(typed, process.cwd(), permissions)
    row.state = run.refused ? "failed" : "done"
    row.text = run.message?.display?.replace(/^! /, "$ ") ?? "$ " + typed + "\n" + run.output
    if (run.message) {
      messages.push(run.message)
      session.messages = messages
      void sessions.save(session).then(refreshSessionCache).catch(() => {})
      void refreshFileCache(true)
    }
    status = run.refused ? "not run: a deny rule in codegoblin.jsonc blocks it" : "ran " + typed.slice(0, 60) + " - the output is in the conversation for your next prompt"
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
      agentName = undefined
      transcript = []
      hiddenEarlier = 0
      historyArchived = false
      messages = [SYSTEM]
      plan = []
      session = sessions.create(selection.provider.id, selection.model.id)
      resumeModelMissing = false
      permissions.reset()
      subagents.reset()
      edits.reset(); railChanges = []
      pastes = []
      pendingImages = []
      spend = { input: 0, output: 0 }
      overlay = undefined
      status = "new conversation"
      setHomeTip(pickTip())
    }
    // /help is a picker too. Printed, it was twenty-five lines that stayed in
    // the conversation for good.
    if (result.kind === "message" && text.trim() === "/help") {
      dialog = Dialogs.open(
        "invoke",
        "Commands",
        COMMANDS.map((command) => ({ label: command.name, hint: command.description, value: command.name })),
        { footer: "enter puts it in the prompt · wheel or pgup/pgdn scroll · esc closes", size: "large" },
      )
      render()
      return
    }
    if (result.kind === "message") transcript.push({ kind: "tool", text: result.text })
    if (result.kind === "agents") {
      if (!result.name) openAgents()
      else await chooseAgent(result.name === "default" ? undefined : result.name)
      render(); return
    }
    if (result.kind === "theme") {
      if (!result.name) { openThemePicker(); render(); return }
      settings = { ...settings, theme: result.name }
      applyTheme(result.name)
      void settingsStore.save(settings)
      status = "theme: " + result.name
    }
    if (result.kind === "effort") {
      if (!result.level) { openEffortPicker(); render(); return }
      // A level this model does not have is refused, never sent as its nearest neighbour.
      const problem = effortProblem(selection.model, selection.provider.label + " " + selection.model.label, result.level)
      if (problem) { status = problem; render(); return }
      settings = settingsStore.withModelEffort(settings, selection.provider.id + "/" + selection.model.id, result.level)
      void settingsStore.save(settings)
      status = "effort: " + result.level + (effortHint(selection.model, result.level) ? " - " + effortHint(selection.model, result.level) : "") + " · " + selection.model.label
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
          { footer: "enter puts it in the prompt · wheel or pgup/pgdn scroll · esc closes", size: "large" },
        )
      }
    }
    if (result.kind === "mcp" && result.toggle) {
      if (!mcp.statuses().some((server) => server.name === result.toggle!.server)) status = "no MCP server called " + result.toggle.server + " - /mcp lists them"
      else setMcpForSession(result.toggle.server, result.toggle.on)
      render(); return
    }
    if (result.kind === "mcp") {
      openMcp()
    }
    if (result.kind === "browser") {
      if (!result.mode) { transcript.push({ kind: "tool", text: browserStatus(mcp) }); render(); return }
      status = result.mode === "off" ? "closing the browser..." : "starting the browser - the first time downloads it..."
      render()
      const line = await switchBrowser(mcp, result.mode)
      status = ""
      transcript.push({ kind: "tool", text: line })
      render(); return
    }
    // The terminal works in the folder it was started in, so worktrees and
    // branches are listed and made here, and opened by starting cgn there.
    if (result.kind === "editor") {
      openEditor()
      return
    }
    if (result.kind === "fold") {
      foldAnswers = !foldAnswers
      status = foldAnswers ? "answers folded to their first lines - /fold unfolds" : "answers shown in full"
      render(); return
    }
    if (result.kind === "voice") {
      await voiceCommand(result.argument)
      render(); return
    }
    if (result.kind === "timestamps") {
      showTimes = !showTimes
      status = showTimes ? "showing when each message was written" : "timestamps hidden"
      render(); return
    }
    if (result.kind === "timeline") {
      openTimeline()
      render(); return
    }
    if (result.kind === "search") {
      openSearch(result.query)
      render(); return
    }
    if (result.kind === "project") {
      status = "the terminal works in the folder it started in - run cgn in another folder, or use /project in the web app"
      render(); return
    }
    if (result.kind === "worktree") {
      const { createWorktree, listWorktrees, repoRoot } = await import("../core/worktrees")
      if (!repoRoot(process.cwd())) { status = "this folder is not in a git repository"; render(); return }
      if (result.action === "new") {
        if (streaming) { status = "wait for the answer to finish first"; render(); return }
        try {
          const made = createWorktree(process.cwd(), result.name!)
          transcript.push({ kind: "tool", text: `made worktree ${result.name} on ${made.branch}: ${made.path}  - open it with: cgn "${made.path}"` })
          status = "worktree ready"
        } catch (error) { status = "worktree failed: " + (error instanceof Error ? error.message : "unknown") }
        render(); return
      }
      const trees = listWorktrees(process.cwd())
      overlay = { title: "Worktrees  (/worktree new <name> makes one)", rows: trees.map((tree) => [tree.main ? "main" : tree.ours ? "cg" : "other", (tree.branch ?? tree.head ?? "") + "  " + tree.path] as [string, string]) }
      render(); return
    }
    if (result.kind === "branch") {
      const { currentBranch, localBranches, repoRoot, switchBranch } = await import("../core/worktrees")
      if (!repoRoot(process.cwd())) { status = "this folder is not in a git repository"; render(); return }
      if (result.name) {
        if (streaming) { status = "wait for the answer to finish first"; render(); return }
        try { switchBranch(process.cwd(), result.name); status = "switched to " + result.name; void refreshFileCache(true); readHomeBranch() }
        catch (error) { status = "could not switch: " + (error instanceof Error ? error.message : "unknown") }
        render(); return
      }
      const here = currentBranch(process.cwd())
      overlay = { title: "Branches  (/branch <name> switches)", rows: localBranches(process.cwd()).map((branch) => [branch === here ? "current" : "", branch] as [string, string]) }
      render(); return
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
            ? formatSpend(spend) + "  (" + formatInput(spend) + " in, " + spend.output.toLocaleString() + " out)"
            : "nothing yet",
        ],
        ["theme", settings.theme],
        ["agent", agentName || "default"],
        ["thinking", settings.thinking ? "shown" : "hidden"],
        [
          "effort",
          currentEffort() === "auto"
            ? "auto" + (selection.model.defaultEffort ? " (= " + selection.model.defaultEffort + " on this model)" : "")
            : currentEffort() + (effortFor(selection.model, currentEffort()) ? "" : "  (not sent - not one of this model's levels)"),
        ],
        ["approved", approved.length ? approved.join(", ") : "nothing yet"],
        ...(permissions.refusedSummary().length ? [["never", permissions.refusedSummary().join(", ")] as [string, string]] : []),
        ["formatter", formatterStatus(process.cwd())],
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
    if (result.kind === "account") { openAccount(result.source); render(); return }
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
        confirmImport(result.source, result.id, "Selected " + IMPORTERS[result.source].label + " conversation")
        render(); return
      }
      await openImport(result.source); return
    }
    if (result.kind === "balance") {
      openUsage(result.provider || selection.provider.id, true)
    }
    if (result.kind === "copy" && result.what === "last") {
      const answer = sessions.lastAnswer(messages)
      if (!answer) status = "nothing to copy yet - no answer in this conversation"
      else {
        try { await copyText(answer); status = "copied the last answer (" + answer.length + " characters)" }
        catch { status = "could not reach the clipboard" }
      }
      render(); return
    }
    if (result.kind === "copy") {
      if (!messages.some((message) => message.role === "user")) { status = "nothing to copy yet - say something first"; render(); return }
      const text = await sessionMarkdown({ ...session, messages }, Date.now())
      try { await copyText(text); status = "copied the whole conversation (" + text.length.toLocaleString("en-US") + " characters); /copy last copies just the latest answer" }
      catch { status = "could not reach the clipboard - /export saves it to a file instead" }
      render(); return
    }
    if (result.kind === "fork") {
      if (messages.filter((message) => message.role !== "system").length === 0) { status = "nothing to fork yet - say something first"; render(); return }
      session.messages = messages
      session.spend = spend
      await sessions.save(session).catch(() => {})
      try {
        const copy = await sessions.fork(session)
        session = copy
        messages = copy.messages
        spend = { input: 0, output: 0 }
        edits.reset(); railChanges = []
        await refreshSessionCache()
        transcript.push({ kind: "tool", text: "forked: you are now in a copy of this conversation; the original is unchanged (/resume to go back)" })
        status = "now in " + copy.title
      } catch { status = "could not fork this conversation" }
      render(); return
    }
    if (result.kind === "local" && /^pull\b/.test(result.argument)) {
      const named = LOCAL_CATALOG.find((entry) => entry.id === result.argument.split(/\s+/)[1])
      if (named) confirmLocalPull(named)
      else openLocalPull()
      render(); return
    }
    if (result.kind === "local") {
      const text = await localCommand(result.argument, selection.provider.id + "/" + selection.model.id)
      transcript.push({ kind: "tool", text })
      // A tools or context choice changes the model's label and window.
      if (selection.provider.runtime) selection = resolveSelection(selection.provider.id + "/" + selection.model.id) ?? selection
      status = result.argument ? text.split("\n")[0]!.slice(0, 90) : "local runtime"
    }
    if (result.kind === "undo" || result.kind === "redo") {
      const forward = result.kind === "redo"
      try {
        const checkpoint = forward ? await edits.redo(process.cwd()) : await edits.undo(process.cwd())
        void refreshRailChanges().then(() => render())
        status = checkpoint
          ? (forward ? "redid " : "undid ") + describeCheckpoint(checkpoint)
          : nothingToDo(edits, forward)
        // Saved straight away, so a restart does not undo the same turn twice.
        if (checkpoint && messages.some((message) => message.role === "user")) {
          session.review = edits.reviewState(process.cwd())
          void sessions.save(session).catch(() => {})
        }
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
        rememberRecent()
      }
    }
    if (result.kind === "favourite") {
      const target = result.id ? resolveSelection(result.id) : selection
      if (!target) { status = "no such model: " + result.id + " - /favourite lists them"; render(); return }
      await starModel(target.provider.id + "/" + target.model.id)
      render(); return
    }
    if (result.kind === "compact") {
      const window = selection.model.contextWindow
      const plan = planCompaction(messages, window)
      // Says why: the most recent quarter of the window is always kept word for
      // word, so a short conversation has nothing older to summarise.
      if (window <= 0) status = "context window unavailable; history unchanged (CLI transport compaction remains automatic)"
      else if (!plan.summarise.length) status = "nothing to compact yet - the whole conversation still fits in the recent part that is kept as it is"
      else {
        // The model writes the summary, as it does when the window fills; a
        // list of the first words of each prompt was all /compact used to
        // leave. Every replaced message goes to the archive first.
        status = "compacting..."
        render()
        try {
          for await (const event of compactConversation({
            provider: selection.provider, modelId: selection.model.id, apiKey: key ?? "", messages, contextWindow: window,
            archive: (replaced) => sessions.appendArchive(session.id, replaced),
          })) {
            if (event.type === "spend") spend = addSpend(spend, { input: event.input, output: event.output, ...(event.cached ? { cached: event.cached } : {}), dollars: costOf(event, selection.model.price) })
          }
          historyArchived = true
          session.messages = messages
          session.spend = spend
          void sessions.save(session).catch(() => {})
          status = "compacted to " + messages.length + " messages"
        } catch (error) {
          status = "could not compact: " + (error instanceof Error ? error.message : "unknown") + " - history unchanged"
        }
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
  let profile: ReturnType<typeof selectedAgent>
  try {
    profile = selectedAgent(agentName, process.cwd())
    selection = await agentSelection(profile, selection)
    key = apiKey(selection.provider.id)
  } catch (error) {
    status = error instanceof Error ? error.message : "Agent unavailable; choose /agents default"
    transcript.push({ kind: "tool", state: "failed", text: status })
    render(); return
  }
  const selectedKind = kindOf(selection.model)
  if (selectedKind !== "text") {
    clearSent()
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

  clearSent()
  palette = undefined
  scroll = 0
  history.push(text)
  historyIndex = -1
  session.provider = selection.provider.id
  session.model = selection.model.id
  session.agent = profile?.name
  // Mentions are read here rather than in the agent so the stored message
  // carries the files with it: a resumed conversation keeps its context.
  // What was folded away goes back before anything sees it.
  // "@explore <task>" hands the task to that agent, with subagents on for this message.
  const delegated = invoked ? undefined : agentMention(unfoldPastes(text), process.cwd())
  if (delegated) boostOnce = true
  const whole = invoked ? invoked.content : delegated ? delegated.content : unfoldPastes(text)
  const mentioned = await expandMentions(whole, process.cwd())
  const seeing = acceptsImages(selection)
  const images = [...mentioned.images, ...pendingImages]
  const pasted = pendingImages.map((image) => image.name)
  pendingImages = []
  messages.push(
    mentioned.files.length || whole !== text || images.length
      ? { role: "user", content: mentioned.content, display: text, images, at: Date.now() }
      : { role: "user", content: text, at: Date.now() },
  )
  transcript.push({ kind: "user", text, at: Date.now() })
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
  /**
   * This step's reasoning and answer - one model response, up to a tool call.
   * Some providers send a sliver of reasoning in the middle of the answer;
   * it joins the step's reasoning, and the answer carries on where it was.
   * Opening a new block for each switch split one answer into two that read
   * as the reply being sent twice.
   */
  let stepThinking: Entry | undefined
  let stepAnswer: Entry | undefined
  turn = new AbortController()
  const turnStarted = Date.now()
  workingSince = turnStarted
  // The user message is already pushed; everything from it on is this turn's.
  const turnFrom = Math.max(0, messages.length - 1)
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
      // Compaction archives what it replaces, so /export still has every word.
      archive: sessions.appendArchive.bind(null, session.id),
      extraTools: withoutServers(mcp, session.mcpOff ?? []),
      askUser,
      // Offered only with /boost - or while subagents started under it are still out.
      subagents: !profile?.tools && (boost || boostOnce || subagents.running().length) ? subagents : undefined,
      tools: profile?.tools,
      // The profile's model override already changed `selection`, so this is
      // the target model's own saved effort, never the parent model's.
      effort: effortFor(selection.model, currentEffort()),
      signal: turn.signal,
      memory: await memory.recall({ project: process.cwd(), session: session.id }),
      instructions: [profile ? "Active agent: " + profile.name + "\n" + profile.prompt : undefined, skillIndex(listSkills(process.cwd())), withoutServers(mcp, session.mcpOff ?? []).notice()].filter(Boolean).join(String.fromCharCode(10, 10)) || undefined,
    })) {
      session.activity ??= normaliseActivity(undefined)
      recordActivity(session.activity, event)
      if (event.type === "thinking") {
        if (!stepThinking) {
          stepThinking = { kind: "thinking", text: "", started: Date.now() }
          // Reasoning that only starts once the answer has: it still goes above the answer.
          const at = stepAnswer ? transcript.indexOf(stepAnswer) : -1
          if (at >= 0) transcript.splice(at, 0, stepThinking)
          else transcript.push(stepThinking)
        }
        stepThinking.text += event.delta
        stepThinking.last = Date.now()
        current = stepAnswer ?? stepThinking
      }
      if (event.type === "text") {
        if (!stepAnswer) {
          stepAnswer = { kind: "agent", text: "", by: selection.provider.label.toLowerCase(), at: Date.now() }
          transcript.push(stepAnswer)
        }
        stepAnswer.text += event.delta
        current = stepAnswer
      }
      if (event.type === "tool_start") {
        current = undefined
        stepThinking = undefined
        stepAnswer = undefined
        callArgs.set(event.id, event.args)
        // Summarised as approvals are, so an edit's row names its file before the cut.
        transcript.push({ kind: "tool", call: event.id, text: toolLabel(event.name) + " " + askedFor(event.name, event.args).replace(/\s+/g, " ").slice(0, 60), state: "running" })
      }
      if (event.type === "spend") {
        spend = addSpend(spend, {
          input: event.input,
          output: event.output,
          ...(event.cached ? { cached: event.cached } : {}),
          dollars: costOf(event, selection.model.price),
        })
      }
      if (event.type === "plan") {
        plan = event.todos
      }
      if (event.type === "retry") {
        status = selection.provider.label + " " + (event.reason === "no connection" ? "could not be reached" : "is busy (" + event.reason + ")") + " - trying again in " + Math.round(event.waitMs / 1000) + "s (" + event.attempt + " of " + event.of + ")"
        render()
        continue
      }
      if (event.type === "compacted") {
        historyArchived = true
        transcript.push({ kind: "tool", text: "compacted context: " + event.before + " -> " + event.after + " messages" })
      }
      if (event.type === "runtime") {
        if (event.state === "loading") status = "loading " + event.model + " into llama.cpp..."
        else transcript.push({ kind: "tool", text: `local model ${event.model} loaded in ${((event.ms ?? 0) / 1000).toFixed(1)} s${event.gpu ? " on the GPU" : " on the CPU"}` })
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
        const why = event.spent !== undefined ? formatSpend({ input: 0, output: 0, dollars: event.spent }) + " spent on this prompt" : event.toolCalls + " tool calls"
        transcript.push({
          kind: "tool",
          text: "paused at the autonomy checkpoint (" + why + ") - " +
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
        // The side panel's changed-files list follows what the tools do.
        void refreshRailChanges().then(() => render())
        const row = rowFor(event.id)
        if (row) {
          if (row.state !== "failed") row.state = /^(error|stopped)/.test(event.result) ? "failed" : "done"
          const shown = toolDetail(event.name, callArgs.get(event.id) ?? "", event.result)
          callArgs.delete(event.id)
          if (shown.summary) row.text += "  ->  " + shown.summary
          if (shown.lines.length) row.detail = shown.lines
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
    if (turn?.signal.aborted && !messages.at(-1)?.stopped) messages.push({ role: "assistant", content: "", stopped: true })
    if (messages.at(-1)?.stopped) transcript.push({ kind: "tool", text: "stopped", state: "failed" })
    else transcript.push({ kind: "worked", text: "worked for " + sessions.workedFor(Date.now() - turnStarted) + " · " + selection.provider.label + " " + selection.model.label })
    streaming = false
    stopArmedUntil = 0
    stopSpinner()
    turn = undefined
    edits.commit(process.cwd())
    sessions.stampNew(messages, turnFrom)
    session.messages = messages
    session.spend = spend
    session.review = edits.reviewState(process.cwd())
    session.activity = normaliseActivity(session.activity, true)
    void sessions.save(session).then(refreshSessionCache).catch(() => {})
    void refreshFileCache(true)
    scheduleIdleCompact()

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
      if (!isCommand(next) || draft.text) {
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
  stopRecorder()
  stopVoice()
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
  agentName = loaded.agent
  spend = loaded.spend ?? { input: 0, output: 0 }
  messages = loaded.messages
  // The model keeps the whole conversation; the screen draws its recent end.
  const shown = sessions.displayWindow(messages)
  transcript = fromMessages(shown.messages)
  hiddenEarlier = shown.hidden
  historyArchived = await sessions.hasArchive(loaded.id)
  scroll = 0
  edits.reset(); railChanges = []
  edits.restoreReview(process.cwd(), loaded.review)
  void refreshRailChanges().then(() => render())
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
setHomeTip(pickTip())

async function loadSettings() {
  settings = await settingsStore.load()
  setModelLists(settings)
  media = await loadMedia()
  applyTheme(settings.theme)
  applyMouse()
  // The recorder takes about a second to come up; started now, the first hold of the space bar is instant.
  if (settings.voiceHold && voiceUsable()) warmRecorder()
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

/**
 * The fork's leader keys: ctrl+x, then a letter, within a second and a half.
 * Each is a shortcut for something a slash command already does, so nothing
 * here behaves differently from typing the command.
 */
const LEADER_RUN: Record<LeaderAction, () => void | Promise<void>> = {
  model: () => openModelPicker(),
  sessions: () => runQuick("/resume"),
  new: () => runQuick("/clear"),
  status: () => runQuick("/status"),
  theme: () => { applyComposer({ text: "/theme ", cursor: 7 }, true); refreshPalette() },
  agents: () => runQuick("/agents"),
  compact: () => runQuick("/compact"),
  undo: () => runQuick("/undo"),
  redo: () => runQuick("/redo"),
  copy: () => runQuick("/copy last"),
  export: () => runQuick("/export"),
  editor: () => openEditor(),
  timeline: () => { openTimeline(); render() },
  quit: () => shutdown(),
}
/** The leader and its letters: the defaults, with tui.json's keybinds over them (the fork's file). */
const keymap = loadKeymap()
// A binding it could not use is said once, rather than silently doing nothing.
if (keymap.problems.length) status = "tui.json: " + keymap.problems[0]
const leaderLabel = (action: LeaderAction) => LEADER_DEFAULTS.find((entry) => entry.action === action)!.label
let leaderUntil = 0

/**
 * Ctrl+G: everything there is to do, each with the keys that do it - the
 * fork's "goblin commands". The leader letters are read from the keymap, so a
 * letter moved in tui.json shows where it went.
 */
const ACTIONS: { label: string; run: string; leader?: LeaderAction; keys?: string }[] = [
  { label: "Switch model", run: "leader:model", leader: "model" },
  { label: "Approval mode", run: "/approvals", keys: "shift+tab" },
  { label: "Settings", run: "/settings" },
  { label: "Conversations", run: "leader:sessions", leader: "sessions" },
  { label: "New conversation", run: "leader:new", leader: "new" },
  { label: "Status", run: "leader:status", leader: "status" },
  { label: "Usage and balance", run: "/usage" },
  { label: "Undo the last change", run: "leader:undo", leader: "undo" },
  { label: "Redo", run: "leader:redo", leader: "redo" },
  { label: "Review changes", run: "/diff" },
  { label: "Compact the conversation", run: "leader:compact", leader: "compact" },
  { label: "Copy the last answer", run: "leader:copy", leader: "copy" },
  { label: "Export as Markdown", run: "leader:export", leader: "export" },
  { label: "Search this conversation", run: "/search" },
  { label: "Jump to a message", run: "leader:timeline", leader: "timeline" },
  { label: "Write the prompt in your editor", run: "leader:editor", leader: "editor" },
  { label: "Browser", run: "/browser" },
  { label: "MCP servers", run: "/mcp" },
  { label: "Theme", run: "leader:theme", leader: "theme" },
  { label: "Agents", run: "leader:agents", leader: "agents" },
  { label: "All commands", run: "/help" },
  { label: "Quit", run: "leader:quit", leader: "quit", keys: "ctrl+c twice" },
]
function openActions() {
  const keysFor = (action: { leader?: LeaderAction; keys?: string }) => {
    const letter = action.leader ? Object.entries(keymap.letters).find(([, each]) => each === action.leader)?.[0] : undefined
    return [letter ? "ctrl+" + keymap.leader + " " + letter : "", action.keys ?? ""].filter(Boolean).join(" \u00b7 ")
  }
  dialog = Dialogs.open("actions", "goblin commands", ACTIONS.map((action) => ({ label: action.label, hint: keysFor(action), value: action.run })), { footer: "type to search \u00b7 enter runs \u00b7 esc closes", size: "medium", filterable: true })
}

/**
 * Ctrl+Up and Ctrl+Down: your previous or next message at the top of the
 * screen - the quick way through a long conversation. Down past the last one
 * goes back to the latest output.
 */
function jumpMessage(direction: -1 | 1) {
  const target = direction < 0 ? [...userStarts].reverse().find((start) => start < lastTop) : userStarts.find((start) => start > lastTop)
  if (target === undefined) { if (direction > 0) scroll = 0; return }
  scroll = Math.max(0, drawnLines - lastRoom - target)
}

/** Runs a slash command as if typed, keeping whatever was being written. */
async function runQuick(command: string) {
  const draft = { text: input, cursor }
  input = command
  cursor = command.length
  palette = undefined
  await send()
  if (!input && draft.text) { input = draft.text; cursor = draft.cursor }
  render()
}

/**
 * /editor: the prompt in an editor of your own. $VISUAL or $EDITOR, else
 * Notepad on Windows and vi elsewhere. The terminal is handed over while it
 * runs - out of the app's screen and raw mode - and taken back after, with
 * what was written in the composer, unsent, to read before pressing enter.
 */
function openEditor() {
  if (secret) return
  const fsMod = require("node:fs") as typeof import("node:fs")
  const os = require("node:os") as typeof import("node:os")
  const pathMod = require("node:path") as typeof import("node:path")
  const { spawnSync } = require("node:child_process") as typeof import("node:child_process")
  const file = pathMod.join(os.tmpdir(), "cg-prompt-" + process.pid + ".md")
  fsMod.writeFileSync(file, input)
  const editor = process.env.VISUAL || process.env.EDITOR || (process.platform === "win32" ? "notepad.exe" : "vi")
  out.write(ansi.pasteOff + "\x1b[?1002l\x1b[?1006l" + ansi.releaseMouse + ansi.showCursor + ansi.mainScreen)
  process.stdin.setRawMode?.(false)
  const result = spawnSync(editor, [file], { stdio: "inherit", shell: process.platform === "win32" && !/\.exe$/i.test(editor) })
  process.stdin.setRawMode?.(true)
  out.write(ansi.altScreen + ansi.ownMouse + ansi.pasteOn)
  applyMouse()
  if (result.error || result.status !== 0) status = "the editor did not finish cleanly (" + (result.error?.message ?? "exit " + result.status) + "); the draft is unchanged"
  else {
    const text = fsMod.readFileSync(file, "utf8").replace(/\r\n/g, String.fromCharCode(10)).replace(/\s+$/, "")
    applyComposer({ text, cursor: text.length }, true)
    // Named by its program: VISUAL may be "code --wait" or a quoted path with arguments.
    const program = pathMod.basename(editor.match(/^"([^"]+)"/)?.[1] ?? editor.split(" ")[0] ?? editor).replace(/\.(exe|cmd|bat)$/i, "")
    status = text ? "edited in " + program + " - enter sends it" : "the editor came back empty"
  }
  try { fsMod.rmSync(file, { force: true }) } catch {}
  render()
}


// --- voice input ------------------------------------------------------------------------------------------

/**
 * Speaking into the prompt box.
 *
 * Two ways in: hold the space bar and let go when done, or /voice to start and Enter (or space) to finish.
 * A terminal is never told that a key was released, only that it was pressed; a held key shows up as the
 * same key arriving again and again at the keyboard's repeat rate. So "held" is several spaces close
 * together, each alone in what the terminal sent, and "let go" is the repeats stopping.
 */
type Listening = { recording?: Recording; hold: boolean; startedAt: number; lastSpace: number; ticker: ReturnType<typeof setInterval>; cancelled?: boolean }
/** Spaces typed so far in what may turn out to be a held space bar, and when the last one came. */
let heldSpaces = 0
let lastSpaceAt = 0
/** A held key repeats about thirty times a second; this is generous to slow keyboards. */
const REPEAT_GAP_MS = 130
/** The pause before a held key begins to repeat. */
const FIRST_GAP_MS = 900
/** How many spaces in a row, at repeat speed, mean the bar is being held. */
const HOLD_SPACES = 4
/** Repeats this long gone mean the bar was let go. */
const RELEASE_MS = 320

const voiceUsable = () => !voiceProblem() && canRecord()

/** A space that arrived alone. Returns true when it was taken as part of holding the bar. */
function spaceHeld(now: number): boolean {
  const gap = now - lastSpaceAt
  lastSpaceAt = now
  heldSpaces = heldSpaces === 0 || gap > (heldSpaces === 1 ? FIRST_GAP_MS : REPEAT_GAP_MS) ? 1 : heldSpaces + 1
  if (heldSpaces < HOLD_SPACES) return false
  // The spaces typed while finding out are taken back: they were the bar being held, not text.
  const typed = heldSpaces
  heldSpaces = 0
  let state = composerState()
  for (let i = 0; i < typed && state.cursor > 0 && state.text[state.cursor - 1] === " "; i++) state = deleteRange(state, "back")
  applyComposer(state, true)
  void startListening(true)
  return true
}

async function startListening(hold: boolean) {
  if (listening || transcribing) return
  const why = voiceProblem()
  if (why) { status = why; render(); return }
  if (!canRecord()) { status = "no recorder found: install arecord (alsa-utils) or sox to use voice here"; render(); return }
  const mine: Listening = { hold, startedAt: Date.now(), lastSpace: Date.now(), ticker: setInterval(() => {
    // Let go of the bar: the repeats have stopped.
    if (listening === mine && mine.hold && mine.recording && Date.now() - mine.lastSpace > RELEASE_MS) void finishListening()
    else if (listening === mine) render()
  }, 80) }
  listening = mine
  palette = undefined
  status = ""
  render()
  // The engine loads while you talk, so it is ready by the time you stop.
  warmVoice()
  try {
    const recording = await record()
    if (mine.cancelled || listening !== mine) { recording.cancel(); return }
    mine.recording = recording
    mine.startedAt = Date.now()
    mine.lastSpace = Date.now()
    render()
  } catch (error) {
    clearInterval(mine.ticker)
    if (listening === mine) listening = undefined
    status = error instanceof Error ? error.message : "could not start recording"
    render()
  }
}

function cancelListening() {
  const mine = listening
  if (!mine) return
  mine.cancelled = true
  clearInterval(mine.ticker)
  mine.recording?.cancel()
  listening = undefined
  status = "recording discarded"
  render()
}

async function finishListening() {
  const mine = listening
  if (!mine?.recording) { cancelListening(); return }
  clearInterval(mine.ticker)
  listening = undefined
  transcribing = true
  status = "turning speech into text…"
  render()
  try {
    const text = await transcribe(await mine.recording.stop(), settings.voiceLanguage)
    if (!text) status = "heard nothing - is the microphone on? " + (mine.hold ? "hold space, wait for the red dot, then speak" : "/voice tries again")
    else {
      const state = composerState()
      const before = state.text.slice(0, state.cursor)
      applyComposer(insertText(state, (before && !/\s$/.test(before) ? " " : "") + text), true)
      status = "from your voice - read it over, then enter sends it"
    }
  } catch (error) {
    status = "voice: " + (error instanceof Error ? error.message : "could not transcribe that")
  } finally {
    transcribing = false
    render()
  }
}

/** The line shown above the prompt box while recording. */
function listeningLine(): string | undefined {
  if (transcribing) return theme.gold + "  ● turning speech into text…" + ansi.reset
  if (!listening) return undefined
  if (!listening.recording) return dim + "  ○ starting the microphone…" + ansi.reset
  const seconds = Math.floor((Date.now() - listening.startedAt) / 1000)
  return theme.error + "  ● listening " + ansi.reset + dim + seconds + "s  ·  " + (listening.hold ? "let go of space to finish" : "enter or space finishes · esc discards") + ansi.reset
}

/** What voice input needs, and the button that gets it. A page to read before a 229 MB download, not after. */
function openVoiceSetup() {
  const state = voiceState()
  const rows: Dialogs.DialogRow[] = []
  const say = (label: string) => rows.push({ label, inert: true })
  if (!state.runtime) {
    say("Voice input needs a speech engine that is not installed here.")
    say("Run  bun install  in the CG-Next folder, then /voice again.")
    say("(sherpa-onnx-node: Windows x64, macOS, Linux x64 and arm64)")
  } else if (state.ready) {
    say("Voice input is set up. Speech is turned into text on this computer;")
    say("nothing you say is sent anywhere.")
    rows.push({ label: "Hold space to talk", hint: settings.voiceHold ? "on" : "off - /voice still records", value: "hold" })
    rows.push({ label: "Language", hint: settings.voiceLanguage === "auto" ? "auto - the model tells" : settings.voiceLanguage, value: "language" })
    rows.push({ label: "Record now", hint: "enter or space finishes, esc discards", value: "record" })
    say("Model: " + state.dir)
  } else if (state.preparing) {
    say("Downloading the speech model: " + Math.floor((state.preparing.received / state.preparing.total) * 100) + "%")
    rows.push({ label: "Stop the download", hint: "what is downloaded is kept", value: "cancel" })
  } else {
    say("Speak instead of typing. Speech is turned into text on this computer,")
    say("by a small model (SenseVoice); nothing you say is sent anywhere.")
    say("")
    say("Download   " + VOICE_NEEDS.download + ", once, from Hugging Face (checked against a fixed SHA-256)")
    say("Disk       " + VOICE_NEEDS.disk)
    say("Memory     " + VOICE_NEEDS.memory)
    say("Takes      " + VOICE_NEEDS.time)
    say("Languages  English, Chinese, Cantonese, Japanese, Korean")
    if (state.problem) say("Last try:  " + state.problem)
    say("")
    rows.push({ label: "Download and set up", hint: "then hold space to talk", value: "setup" })
    rows.push({ label: "Later", value: "later" })
  }
  dialog = Dialogs.open("voice", "Voice input", rows, { size: "large", footer: "enter chooses · esc closes" })
}

function setUpVoice() {
  status = "voice: starting the download…"
  render()
  void prepareVoice({ onProgress: (state) => {
    if (state.preparing) status = "voice: downloading the " + state.preparing.label + " - " + Math.floor((state.preparing.received / state.preparing.total) * 100) + "% of " + VOICE_NEEDS.download + " · /voice cancel stops it"
    render()
  } }).then(() => {
    warmRecorder()
    status = "voice is ready - hold space and speak, or /voice"
    render()
  }).catch((error: unknown) => {
    status = "voice: " + (error instanceof Error ? error.message : "setup failed")
    render()
  })
}

async function voiceCommand(argument: string) {
  if (argument === "cancel") { status = cancelVoiceSetup() ? "stopping the download…" : "no voice download is running"; return }
  if (argument === "setup" || argument === "settings") { openVoiceSetup(); return }
  if (argument === "hold") {
    settings = { ...settings, voiceHold: !settings.voiceHold }
    void settingsStore.save(settings)
    status = settings.voiceHold ? "hold space to talk: on" : "hold space to talk: off - /voice still records"
    return
  }
  if (argument) { status = "/voice records · /voice setup · /voice hold · /voice cancel"; return }
  if (voiceProblem()) { openVoiceSetup(); return }
  await startListening(false)
}

process.stdin.on("data", (chunk) => {
  let dirty = false
  // A held space bar repeats alone; spaces inside typed or pasted text come with other characters.
  const onlySpaces = /^ +$/.test(chunk.toString())

  for (const pressed of readKeys(chunk.toString())) {
    // While recording, the keyboard is the recorder's: space keeps a hold alive or ends a /voice recording,
    // enter ends it, escape throws it away. Nothing typed by accident lands in the prompt.
    if (listening) {
      if (pressed.type === "char" && pressed.value === " ") {
        listening.lastSpace = Date.now()
        if (!listening.hold && listening.recording && Date.now() - listening.startedAt > 400) void finishListening()
      } else if (pressed.type === "enter") void finishListening()
      else if (pressed.type === "escape" || (pressed.type === "ctrl" && pressed.value === "c")) cancelListening()
      continue
    }
    if (transcribing && pressed.type === "char" && pressed.value === " " && onlySpaces) continue
    // ctrl+x arms the leader; the next letter picks the shortcut.
    if (pressed.type === "ctrl" && pressed.value === keymap.leader && !secret) {
      leaderUntil = Date.now() + 1500
      status = "ctrl+" + keymap.leader + "  " + Object.entries(keymap.letters).map(([key, action]) => key + " " + leaderLabel(action)).join(" · ")
      render(); continue
    }
    if (leaderUntil) {
      const armed = Date.now() < leaderUntil
      leaderUntil = 0
      const action = pressed.type === "char" ? keymap.letters[pressed.value.toLowerCase()] : undefined
      if (armed && action) {
        status = ""
        dialog = undefined
        void LEADER_RUN[action]()
        render(); continue
      }
      if (armed) { status = ""; render(); continue }
    }
    if (pressed.type === "ctrl" && pressed.value === "g" && !secret) {
      openActions()
      render(); continue
    }
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
      if (target === "model") openModelPicker()
      if (target === "settings") openSettings()
      if (target === "sessions") {
        if (streaming) { status = "sessions cannot change during a turn; use /resume to queue" }
        else void openSessions().then(render)
      }
      if (target === "usage") openUsage()
      render(); continue
    }
    if (pressed.type === "fn" && pressed.n === 2 && !dialog && !secret) {
      cycleRecentModel(pressed.shift ? -1 : 1)
      render()
      continue
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
      if (dialog.kind === "sessions" && pressed.type === "ctrl" && pressed.value === "p") { void pinInDialog(); continue }
      if (dialog.kind === "sessions" && pressed.type === "ctrl" && pressed.value === "r") { renameInDialog(); continue }
      // In a list you can search, typing narrows it and backspace widens it again.
      if (dialog.filterable && pressed.type === "char") { dialog = Dialogs.filter(dialog, (dialog.query ?? "") + pressed.value); render(); continue }
      if (dialog.filterable && pressed.type === "backspace") { dialog = Dialogs.filter(dialog, (dialog.query ?? "").slice(0, -1)); render(); continue }
      // ctrl+f stars the highlighted model, as in the fork's model dialog.
      if (dialog.kind === "model-picker" && pressed.type === "ctrl" && pressed.value === "f") {
        const value = Dialogs.selected(dialog)?.value
        if (value) void starModel(value).then(() => { if (dialog?.kind === "model-picker") openModelPicker(value); render() })
        continue
      }
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

    // A question from the model owns the keys while its choices are up. While
    // the person types their own answer, the composer is theirs and escape
    // goes back to the choices.
    if (asking && !pending) {
      const entry = asking
      if (entry.typing) {
        if (pressed.type === "escape" && !palette) { entry.typing = false; input = ""; cursor = 0; status = ""; render(); continue }
      } else {
        const options = entry.question.options
        const own = options.length
        if (pressed.type === "up") { askingChoice = Math.max(0, askingChoice - 1); render(); continue }
        if (pressed.type === "down") { askingChoice = Math.min(own, askingChoice + 1); render(); continue }
        if (pressed.type === "escape") { settleQuestion(entry, undefined); continue }
        // A number picks that choice: on a single choice it answers at once,
        // on several it ticks or unticks it, and the last number is typing your own.
        let picked = false
        if (pressed.type === "char" && /^[1-9]$/.test(pressed.value) && Number(pressed.value) <= own + 1) {
          const index = Number(pressed.value) - 1
          askingChoice = index
          if (entry.question.multiple && index < own) {
            if (entry.picked.has(index)) entry.picked.delete(index)
            else entry.picked.add(index)
            render(); continue
          }
          picked = true
        }
        if (pressed.type === "char" && pressed.value === " " && entry.question.multiple && askingChoice < own) {
          if (entry.picked.has(askingChoice)) entry.picked.delete(askingChoice)
          else entry.picked.add(askingChoice)
          render(); continue
        }
        if (pressed.type === "enter" || picked) {
          if (askingChoice === own) {
            entry.typing = true
            // The box and the key hints say what to do now; a third copy in the status only pushed the model name off the line.
            status = ""
            render(); continue
          }
          const chosen = entry.question.multiple && entry.picked.size
            ? [...entry.picked].sort((a, b) => a - b).map((index) => options[index]!.label)
            : [options[askingChoice]!.label]
          settleQuestion(entry, chosen)
          continue
        }
        // A stray key must not answer for the person.
        continue
      }
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
      const choices = decisionsFor(pending.tool)
      if (pressed.type === "down") { pendingChoice = Math.min(choices.length - 1, pendingChoice + 1); render(); continue }
      if (pressed.type === "enter") { answer(choices[pendingChoice]!.id); continue }
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
        // /model and /connect are pop-ups, like /theme and /effort: favourites and recent models are there,
        // and a name is never cut short. Typing "/model " still lists matches under the prompt.
        if (chosen === "/model" || chosen === "/connect") {
          input = ""; cursor = 0; palette = undefined
          if (chosen === "/model") openModelPicker(); else openConnect()
          render()
          continue
        }
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
        // An empty paste is Windows Terminal's Ctrl+V with only a picture on the clipboard.
        if (!pressed.value.trim()) { void attachClipboardImage(true); break }
        // Newlines inside a paste are content. A paste that is only one
        // short line is just typing, and goes in as it is - unless it is a
        // file dropped from Explorer, which becomes a mention instead.
        const pastedText = pressed.value.replace(/\r\n?/g, String.fromCharCode(10))
        const insertPaste = () => applyComposer(insertText(composerState(), droppedMentions(pastedText, process.cwd()) ?? foldPaste(pastedText)), true)
        // Pictures dropped from Explorer are attached as pictures, wherever they are on disk: a screenshot
        // is rarely inside the project, and as a bare path the model went off to open the file itself.
        if (!pastedText.trim().includes(String.fromCharCode(10)) && imageTypeOf(pastedText.trim().replace(/"$/, ""))) {
          void droppedImages(pastedText, process.cwd()).then((pictures) => {
            if (pictures) {
              pendingImages.push(...pictures)
              status = "attached " + pictures.map((picture) => picture.name).join(", ") + " - sends with the next message" + (acceptsImages(selection) ? "" : " (this model cannot see images; pick a vision model)")
            } else insertPaste()
            render()
          })
          break
        }
        insertPaste()
        dirty = true
        break
      }
      case "escape":
        if (secret) { secret = undefined; input = ""; cursor = 0; anchor = undefined; status = "cancelled"; dirty = true; break }
        if (renaming) { renaming = undefined; input = ""; cursor = 0; anchor = undefined; status = "not renamed"; dirty = true; break }
        // Escape drops a selection before it clears the line, so losing a
        // highlight does not also lose everything you had written.
        if (anchor !== undefined) { anchor = undefined; dragged = false; dirty = true; break }
        if (input) { applyComposer({ text: "", cursor: 0 }, true); dirty = true }
        else if (streaming) {
          // Two presses: Esc closes and clears many things, and one stray
          // press used to end a long turn - and lose what it was doing.
          if (Date.now() < stopArmedUntil) {
            stopArmedUntil = 0
            turn?.abort()
            subagents.stopAll()
            status = "stopped"
          } else stopArmedUntil = Date.now() + 2000
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
        // Ctrl+Home with nothing typed goes to the start of the conversation.
        if (pressed.ctrl && !input) { scroll = Number.MAX_SAFE_INTEGER; dirty = true; break }
        applyComposer(moveTo(composerState(), { to: 0, select: Boolean(pressed.shift) }))
        dirty = true
        break
      case "end":
        // Ctrl+End - or End with nothing typed - goes back to the latest output.
        if (scroll > 0 && (pressed.ctrl || !input)) { scroll = 0; dirty = true; break }
        applyComposer(moveTo(composerState(), { to: input.length, select: Boolean(pressed.shift) }))
        dirty = true
        break
      case "up":
        if (pressed.ctrl) { jumpMessage(-1); dirty = true; break }
        if (history.length) {
          historyIndex = historyIndex < 0 ? history.length - 1 : Math.max(0, historyIndex - 1)
          input = history[historyIndex] ?? ""
          cursor = input.length
          dirty = true
        }
        break
      case "down":
        if (pressed.ctrl) { jumpMessage(1); dirty = true; break }
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
      // A page at a time, less two lines so the eye keeps its place.
      case "pageup": scroll += Math.max(3, lastRoom - 2); dirty = true; break
      case "pagedown": scroll = Math.max(0, scroll - Math.max(3, lastRoom - 2)); dirty = true; break
      case "ctrl":
        // Terminals that hand Ctrl+V to the app (rather than pasting text themselves): picture paste.
        if (pressed.value === "v") void attachClipboardImage(true)
        if (pressed.value === "o") { expandThinking = !expandThinking; status = expandThinking ? "showing reasoning in full" : "reasoning folded to one line"; dirty = true }
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
        if (pressed.value === " " && onlySpaces && settings.voiceHold && !secret && !renaming && !dialog && !pending && !asking && voiceUsable()) {
          if (spaceHeld(Date.now())) { dirty = false; break }
        } else heldSpaces = 0
        break
    }
  }

  if (dirty) { refreshPalette(); render() }
})

process.on("SIGINT", shutdown)
