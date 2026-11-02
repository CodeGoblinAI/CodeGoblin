import { COMMANDS, normalizeCommand } from "../core/commands"
import {
  allSelections,
  selectionsByKind,
  selectionsOfKind,
  kindFromWord,
  pickerSection,
  CONNECTABLE,
  connectChoices,
} from "../core/providers"
import { pickerRows } from "../core/favourites"
import { findMention } from "../core/mention"
import { theme, dim, ansi } from "./ansi"
import { displayWidth, truncateToWidth, padToWidth } from "./width"

/**
 * The popup shown while typing a slash command.
 *
 * Matching happens as you type and the selection moves with up and down, so a
 * command can be picked without remembering its exact name.
 */
export type PaletteItem = { value: string; hint: string }


/** Named agents, so @ can offer them before files. */
let agentItems: { name: string; description: string }[] = []
export function setAgents(agents: { name: string; description: string }[]) {
  agentItems = agents.map(({ name, description }) => ({ name, description }))
}

/** Favourite and recent models, so the model list can put them first. */
let modelLists: { favourites: string[]; recents: string[] } = { favourites: [], recents: [] }
export function setModelLists(lists: { favourites: string[]; recents: string[] }) {
  modelLists = { favourites: [...lists.favourites], recents: [...lists.recents] }
}

/** Which providers already have a key, so the list can say so. */
let connectedIds = new Set<string>()
export function setConnectedProviders(ids: string[]) {
  connectedIds = new Set(ids)
}

/**
 * Files the @ picker offers.
 *
 * The app refreshes this on mention use and after turns, sharing and throttling
 * tree walks so typing stays immediate while new project files become visible.
 */
let fileCache: string[] = []
export function setFileCache(files: string[]) {
  fileCache = files
}

/** Custom commands and skills, offered after the built-ins. Filled by the app, like the file list. */
let invocations: PaletteItem[] = []
export function setInvocations(items: PaletteItem[]) {
  // A to Z, so a skill is found where its name says it will be.
  invocations = [...items].sort((a, b) => a.value.localeCompare(b.value))
}


/** Basename matches first, then the shortest path: what gets typed is usually a filename. */
function rankFiles(query: string): string[] {
  if (!query) return fileCache.slice(0, LIST_LIMIT)
  const needle = query.toLowerCase()
  const scored: { file: string; score: number }[] = []
  for (const file of fileCache) {
    const lower = file.toLowerCase()
    const base = lower.slice(lower.lastIndexOf("/") + 1)
    const score = base.startsWith(needle) ? 0 : base.includes(needle) ? 1 : lower.includes(needle) ? 2 : -1
    if (score >= 0) scored.push({ file, score })
  }
  return scored
    .sort((a, b) => a.score - b.score || a.file.length - b.file.length)
    .slice(0, LIST_LIMIT)
    .map((entry) => entry.file)
}

/**
 * The popup contents, or nothing.
 *
 * Never an empty array. An empty array is truthy, so every `if (palette)`
 * guard let it through and the first tab or enter read palette[index] off a
 * list with no rows - which is how a filter that matched nothing crashed the
 * app instead of simply closing the popup.
 */
export function paletteFor(input: string, cursor = input.length): PaletteItem[] | undefined {
  const normalized = normalizeCommand(input)
  const found = paletteMatches(normalized, cursor + normalized.length - input.length)
  return found && found.length ? found : undefined
}

function paletteMatches(input: string, cursor: number): PaletteItem[] | undefined {
  // @ opens the file picker wherever the caret happens to be; / only ever
  // starts a command, so it is only meaningful at the beginning of the line.
  const mention = findMention(input, cursor)
  if (mention) {
    // At the start of a message, an agent's name hands the task to that agent.
    const atStart = input.slice(0, cursor).trimStart().startsWith("@") && !input.slice(0, cursor).trimStart().includes(" ")
    const agents = atStart
      ? agentItems.filter((agent) => agent.name.toLowerCase().startsWith(mention.query.toLowerCase())).map((agent) => ({ value: "@" + agent.name, hint: "agent - " + agent.description }))
      : []
    const files = rankFiles(mention.query).map((file) => ({
      value: "@" + file,
      hint: file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : "in this folder",
    }))
    const items = [...agents, ...files]
    return items.length ? items : undefined
  }

  // A / that starts a word mid-prompt completes command names too, the way @
  // completes files there: "hi there /cl" offers /clear. Argument lists stay
  // line-start only - a sentence is not the place for a model picker.
  if (!input.startsWith("/")) {
    const token = slashToken(input, cursor)
    if (!token) return undefined
    const query = token.toLowerCase()
    const matches = COMMANDS.filter((command) => command.name.startsWith(query)).map((command) => ({
      value: command.name,
      hint: command.description,
    }))
    for (const item of invocations) if (item.value.toLowerCase().startsWith(query)) matches.push(item)
    return matches.length ? matches.slice(0, LIST_LIMIT) : undefined
  }

  // "/model " with an argument lists models instead of commands; "/favourite "
  // lists the same models, to star or unstar one.
  const modelCommand = /^\/(model|favourite)\s+/.exec(input)?.[1]
  if (modelCommand) {
    const query = input.slice(input.indexOf(" ") + 1).trim().toLowerCase()
    // One list of models, in sections, favourites and recents first. Typing a
    // section name narrows to it, so typing image is how you get to the
    // models that draw.
    const kind = kindFromWord(query)
    const pool = pickerRows(kind ? selectionsOfKind(kind) : selectionsByKind(), modelLists)
    return pool
      // Whether a model can actually run is the first thing worth knowing
      // about it. Without this every model read as available and the only way
      // to find out otherwise was to pick one and send a prompt.
      .map(({ selection: s, section, favourite }) => ({
        value: `/${modelCommand} ${s.provider.id}/${s.model.id}`,
        hint:
          `${favourite ? "\u2605 " : ""}${section} \u00b7 ${s.provider.label} ${s.model.label}` +
          (s.provider.local || connectedIds.has(s.provider.id) ? "" : "  \u00b7 no key"),
      }))
      .filter(
        (item) =>
          kind ||
          !query ||
          item.value.toLowerCase().includes(query) ||
          item.hint.toLowerCase().includes(query),
      )
      .sort((a, b) => Number(b.value.toLowerCase() === `/${modelCommand} ` + query) - Number(a.value.toLowerCase() === `/${modelCommand} ` + query))
      .slice(0, LIST_LIMIT)
  }

  // "/connect " lists providers to connect, because the alternative is knowing
  // the id already - which is the thing that made it unusable.
  if (/^\/connect\s+/.test(input)) {
    const query = input.slice(input.indexOf(" ") + 1).trim().toLowerCase()
    // A short list until something is typed; the "more" row just reopens it.
    return connectChoices(query, (id) => connectedIds.has(id)).map((entry) => ({
      value: `/connect ${entry.id}`,
      hint: `${entry.label}  ${entry.connected ? "connected" : entry.about}`,
    })).slice(0, LIST_LIMIT)
  }

  // "/resume " no longer completes to an id. The picker is where a
  // conversation is opened and the only place one can be deleted, and a
  // second way in that skips it means the delete is never found.

  const query = input.toLowerCase()
  const matches = COMMANDS.filter((command) => command.name.startsWith(query)).map((command) => ({
    value: command.name,
    hint: command.description,
  }))
  for (const item of invocations) if (item.value.toLowerCase().startsWith(query)) matches.push(item)
  return matches.length ? matches.slice(0, LIST_LIMIT) : undefined
}

/**
 * The /word the caret sits in, if it starts a word: at the line start or
 * after whitespace. Slashes inside paths and units ("a/b", "$5/day") are not
 * commands and never trigger.
 */
export function slashToken(input: string, cursor: number): string | undefined {
  const before = input.slice(0, cursor)
  const slash = before.lastIndexOf("/")
  if (slash < 0) return undefined
  if (slash > 0 && !/\s/.test(before[slash - 1]!)) return undefined
  const token = before.slice(slash)
  if (!/^\/[A-Za-z0-9_-]*$/.test(token)) return undefined
  return token
}

/** Where that token sits, so picking a row replaces the word, not the line. */
export function slashRange(input: string, cursor: number): { start: number; end: number } | undefined {
  const token = slashToken(input, cursor)
  if (token === undefined) return undefined
  return { start: cursor - token.length, end: cursor }
}

/**
 * How many matches are kept, and how many are on screen at once.
 *
 * These used to be one number, which is why the model list showed only text
 * models: sixteen of those come first, the list was cut at eight, and the
 * image, voice and 3D sections were unreachable unless you already knew to
 * type their name. The list is long now, and the window scrolls through it.
 */
const LIST_LIMIT = 60
const VISIBLE_ROWS = 9

export function renderPalette(items: PaletteItem[], selected: number, width: number, maxHeight = Infinity): string[] {
  if (maxHeight < 4) return []
  const visibleRows = Math.max(1, Math.min(VISIBLE_ROWS, Math.floor(maxHeight) - 3))
  // Size to content, not to the terminal: a two-word command list should not
  // draw a box across the whole screen. The value column takes what the
  // longest entry needs so names are never cut in half.
  const longestValue = items.reduce((max, item) => Math.max(max, displayWidth(item.value)), 0)
  const longestHint = items.reduce((max, item) => Math.max(max, displayWidth(item.hint)), 0)

  const available = Math.max(30, Math.min(width - 6, 110))
  const valueColumn = Math.min(longestValue, available - 12)
  const hintColumn = Math.min(longestHint, Math.max(0, available - valueColumn - 6))

  // marker(2) + value + gap(2) + hint
  const inner = 2 + valueColumn + 2 + hintColumn
  const rule = "─".repeat(inner)
  const lines = [theme.border + "  ╭" + rule + "╮" + ansi.reset]

  // Keep the selected row on screen, and prefer a full window so the list
  // does not shrink as the selection nears the end.
  const start = Math.max(0, Math.min(selected - Math.floor(visibleRows / 2), items.length - visibleRows))
  const shown = items.slice(start, start + visibleRows)

  for (const [offset, item] of shown.entries()) {
    const index = start + offset
    const active = index === selected
    const marker = active ? theme.goblin + "❯ " + ansi.reset : "  "
    const value = padToWidth(truncateToWidth(item.value, valueColumn), valueColumn)
    const hint = padToWidth(truncateToWidth(item.hint, hintColumn), hintColumn)
    const body = marker + (active ? theme.text : theme.muted) + value + ansi.reset + "  " + dim + hint + ansi.reset
    // Close the row so the box reads as a box rather than an open bracket.
    lines.push(theme.border + "  │" + ansi.reset + body + theme.border + "│" + ansi.reset)
  }

  if (items.length > visibleRows) {
    const position = padToWidth(`  ${selected + 1} of ${items.length}`, inner)
    lines.push(theme.border + "  │" + ansi.reset + dim + position + ansi.reset + theme.border + "│" + ansi.reset)
  }
  lines.push(theme.border + "  ╰" + rule + "╯" + ansi.reset)
  return lines
}
