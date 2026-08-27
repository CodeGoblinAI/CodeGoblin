import { COMMANDS } from "../core/commands"
import { allSelections } from "../core/providers"
import { theme, dim, ansi } from "./ansi"

/**
 * The popup that appears while typing a slash command.
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
  const inner = Math.max(24, Math.min(width - 4, 64))
  const lines = [theme.border + "  ╭" + "─".repeat(inner) + "╮" + ansi.reset]

  for (const [index, item] of items.entries()) {
    const active = index === selected
    const label = item.value.padEnd(22).slice(0, 22)
    const hint = item.hint.slice(0, Math.max(0, inner - 24))
    const body = (active ? theme.goblin + "❯ " : "  ") + label + dim + hint + ansi.reset
    lines.push(theme.border + "  │" + ansi.reset + body.padEnd(0))
  }

  lines.push(theme.border + "  ╰" + "─".repeat(inner) + "╯" + ansi.reset)
  return lines
}
