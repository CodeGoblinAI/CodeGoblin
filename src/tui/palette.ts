import { COMMANDS } from "../core/commands"
import {
  allSelections,
  selectionsByKind,
  selectionsOfKind,
  kindFromWord,
  kindOf,
  KIND_LABEL,
  CONNECTABLE,
} from "../core/providers"
import { findMention } from "../core/mention"
import {
  MEDIA_OPTIONS,
  optionById,
  labelOf,
  valueOf,
  DEFAULT,
  type MediaChoice,
  type MediaSettings,
} from "../core/media-settings"
import { theme, dim, ansi } from "./ansi"
import { displayWidth, truncateToWidth, padToWidth } from "./width"

/**
 * The popup shown while typing a slash command.
 *
 * Matching happens as you type and the selection moves with up and down, so a
 * command can be picked without remembering its exact name.
 */
export type PaletteItem = { value: string; hint: string }

/**
 * Sessions the palette can offer.
 *
 * paletteFor is synchronous because it runs on every keystroke, so the list
 * is refreshed alongside the session store rather than read from disk here.
 */
let sessionCache: { id: string; title: string }[] = []

/** Which providers already have a key, so the list can say so. */
let connectedIds = new Set<string>()
export function setConnectedProviders(ids: string[]) {
  connectedIds = new Set(ids)
}
export function setSessionCache(sessions: { id: string; title: string }[]) {
  sessionCache = sessions
}

/**
 * Files the @ picker offers.
 *
 * Walking the tree on every keystroke would be far too slow, so the app fills
 * this once at startup, the same way it fills the session list.
 */
let fileCache: string[] = []
export function setFileCache(files: string[]) {
  fileCache = files
}

/**
 * Media settings, and the voices an account has.
 *
 * The settings come in the same way the session list does - the app owns
 * them and hands them over, because paletteFor runs on every keystroke and
 * cannot read a file. Voices are the same, except they come from a network
 * call the app makes the first time somebody asks for one.
 */
let mediaSettings: MediaSettings = {}
export function setMediaSettings(settings: MediaSettings) {
  mediaSettings = settings
}

let voices: MediaChoice[] = []
let voicesLoaded = false
/** Why the list is empty, when it is - "no key" and "none saved" are different. */
let voicesNote = ""
export function setVoices(list: MediaChoice[], note = "") {
  voices = list
  voicesNote = note
  voicesLoaded = true
}
/** Whether the voice list still needs fetching, so the app knows to fetch it. */
export function needsVoices(input: string): boolean {
  return !voicesLoaded && input.startsWith("/set audio.voice")
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
  const found = paletteMatches(input, cursor)
  return found && found.length ? found : undefined
}

function paletteMatches(input: string, cursor: number): PaletteItem[] | undefined {
  // @ opens the file picker wherever the caret happens to be; / only ever
  // starts a command, so it is only meaningful at the beginning of the line.
  const mention = findMention(input, cursor)
  if (mention) {
    const files = rankFiles(mention.query)
    if (!files.length) return undefined
    return files.map((file) => ({
      value: "@" + file,
      hint: file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : "in this folder",
    }))
  }

  if (!input.startsWith("/")) return undefined

  // "/model " with an argument lists models instead of commands.
  if (/^\/model\s+/.test(input)) {
    const query = input.slice(input.indexOf(" ") + 1).trim().toLowerCase()
    // One list of models, in sections. Typing a section name narrows to it,
    // so typing image is how you get to the models that draw.
    const kind = kindFromWord(query)
    const pool = kind ? selectionsOfKind(kind) : selectionsByKind()
    return pool
      .map((s) => ({
        value: `/model ${s.provider.id}/${s.model.id}`,
        hint: `${KIND_LABEL[kindOf(s.model)]} \u00b7 ${s.provider.label} ${s.model.label}`,
      }))
      .filter(
        (item) =>
          kind ||
          !query ||
          item.value.toLowerCase().includes(query) ||
          item.hint.toLowerCase().includes(query),
      )
      .slice(0, LIST_LIMIT)
  }

  // "/set " lists the knobs, and "/set <one> " lists what that one takes.
  // Two levels of the same list rather than a dialog of its own: the popup
  // already scrolls, filters and completes, and a settings screen would have
  // to learn all three again.
  if (/^\/set\s/.test(input)) {
    const rest = input.slice(input.indexOf(" ") + 1)
    const [word, ...tail] = rest.split(/\s+/)
    const option = optionById(word)

    // Past the option name: offer its values.
    if (option && /\s/.test(rest)) {
      const query = tail.join(" ").trim().toLowerCase()
      // The default is always offered, so an empty voice list is never an
      // empty popup - which means "still loading" has to be said rather than
      // shown by absence.
      const pending: MediaChoice[] =
        option.dynamic === "voices" && !voicesLoaded
          ? [{ id: "", label: "loading voices from your account…" }]
          : []
      const pool = option.dynamic === "voices"
        ? [{ id: DEFAULT, label: "account default" }, ...voices, ...pending]
        : option.choices
      const current = valueOf(mediaSettings, option.id)
      const rows = pool
        .map((choice) => ({
          value: "/set " + option.id + " " + choice.id,
          hint: choice.label + (choice.id === current ? "   \u2713 set" : ""),
        }))
        .filter((item) => !query || item.value.toLowerCase().includes(query) || item.hint.toLowerCase().includes(query))
        .slice(0, LIST_LIMIT)
      // An empty voice list is not an empty answer - it means nobody has
      // fetched them yet, and saying so beats an empty box.
      if (!rows.length && option.dynamic === "voices") {
        return [{ value: input, hint: voicesLoaded ? voicesNote || "no voices on this account" : "loading voices\u2026" }]
      }
      return rows
    }

    const query = word.trim().toLowerCase()
    return MEDIA_OPTIONS.map((entry) => ({
      value: "/set " + entry.id,
      hint: labelOf(entry, valueOf(mediaSettings, entry.id), voices),
    }))
      .filter((item) => !query || item.value.toLowerCase().includes(query))
      .slice(0, LIST_LIMIT)
  }
  // "/connect " lists providers to connect, because the alternative is knowing
  // the id already - which is the thing that made it unusable.
  if (/^\/connect\s+/.test(input)) {
    const query = input.slice(input.indexOf(" ") + 1).trim().toLowerCase()
    return CONNECTABLE.map((entry) => ({
      value: `/connect ${entry.id}`,
      hint: `${entry.label}  ${connectedIds.has(entry.id) ? "connected" : entry.about}`,
    }))
      .filter((item) => !query || item.value.toLowerCase().includes(query) || item.hint.toLowerCase().includes(query))
      .slice(0, LIST_LIMIT)
  }

  // "/resume " lists saved conversations the same way "/model " lists models,
  // so both are picked from a list rather than typed from memory.
  // String comparison rather than a pattern: escaping a regex through
  // tooling has silently broken this check twice already.
  const RESUME_ALIASES = ["/resume", "/sessions", "/continue"]
  const resumeCommand = RESUME_ALIASES.find((name) => input.startsWith(name + " "))
  if (resumeCommand) {
    const query = input.slice(resumeCommand.length).trim().toLowerCase()
    return sessionCache
      .map((entry) => ({ value: resumeCommand + " " + entry.id, hint: entry.title }))
      .filter((item) => !query || item.hint.toLowerCase().includes(query) || item.value.includes(query))
      .slice(0, LIST_LIMIT)
  }

  const query = input.toLowerCase()
  const matches = COMMANDS.filter((command) => command.name.startsWith(query)).map((command) => ({
    value: command.name,
    hint: command.description,
  }))
  return matches.length ? matches : undefined
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

export function renderPalette(items: PaletteItem[], selected: number, width: number): string[] {
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
  const start = Math.max(0, Math.min(selected - Math.floor(VISIBLE_ROWS / 2), items.length - VISIBLE_ROWS))
  const shown = items.slice(start, start + VISIBLE_ROWS)

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

  if (items.length > VISIBLE_ROWS) {
    const position = padToWidth(`  ${selected + 1} of ${items.length}`, inner)
    lines.push(theme.border + "  │" + ansi.reset + dim + position + ansi.reset + theme.border + "│" + ansi.reset)
  }
  lines.push(theme.border + "  ╰" + rule + "╯" + ansi.reset)
  return lines
}
