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

/** Basename matches first, then the shortest path: what gets typed is usually a filename. */
function rankFiles(query: string): string[] {
  if (!query) return fileCache.slice(0, 8)
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
    .slice(0, 8)
    .map((entry) => entry.file)
}

export function paletteFor(input: string, cursor = input.length): PaletteItem[] | undefined {
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
      .slice(0, 8)
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
      .slice(0, 9)
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
      .slice(0, 8)
  }

  const query = input.toLowerCase()
  const matches = COMMANDS.filter((command) => command.name.startsWith(query)).map((command) => ({
    value: command.name,
    hint: command.description,
  }))
  return matches.length ? matches : undefined
}

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

  for (const [index, item] of items.entries()) {
    const active = index === selected
    const marker = active ? theme.goblin + "❯ " + ansi.reset : "  "
    const value = padToWidth(truncateToWidth(item.value, valueColumn), valueColumn)
    const hint = padToWidth(truncateToWidth(item.hint, hintColumn), hintColumn)
    const body = marker + (active ? theme.text : theme.muted) + value + ansi.reset + "  " + dim + hint + ansi.reset
    // Close the row so the box reads as a box rather than an open bracket.
    lines.push(theme.border + "  │" + ansi.reset + body + theme.border + "│" + ansi.reset)
  }

  lines.push(theme.border + "  ╰" + rule + "╯" + ansi.reset)
  return lines
}
