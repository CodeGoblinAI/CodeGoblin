import { COMMANDS } from "../core/commands"
import { allSelections } from "../core/providers"
import { theme, dim, ansi } from "./ansi"
import { displayWidth, truncateToWidth, padToWidth } from "./width"

/**
 * The popup shown while typing a slash command.
 *
 * Matching happens as you type and the selection moves with up and down, so a
 * command can be picked without remembering its exact name.
 */
export type PaletteItem = { value: string; hint: string }

export function paletteFor(input: string): PaletteItem[] | undefined {
  if (!input.startsWith("/")) return undefined

  // "/model " with an argument lists models instead of commands.
  if (/^\/model\s+/.test(input)) {
    const query = input.slice(input.indexOf(" ") + 1).trim().toLowerCase()
    return allSelections()
      .map((s) => ({ value: `/model ${s.provider.id}/${s.model.id}`, hint: `${s.provider.label} ${s.model.label}` }))
      .filter((item) => !query || item.value.toLowerCase().includes(query))
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
