/**
 * CodeGoblin TUI shell.
 *
 * Renders the real layout with nothing wired behind it: no model, no session,
 * no tools. The point is to see and feel the interface first, then attach
 * behaviour to a shape that already exists.
 *
 *   bun src/tui/app.ts
 *
 * Written on raw ANSI rather than a TUI framework. What a terminal UI needs to
 * begin is small: cursor control, colour, and a redraw on resize.
 */
import { ansi, theme, dim, bold } from "./ansi"
import { WORDMARK, WORDMARK_WIDTH, COMPACT } from "./wordmark"

const out = process.stdout
let input = ""

const size = () => ({ cols: out.columns ?? 80, rows: out.rows ?? 24 })
const pad = (text: string, width: number) => " ".repeat(Math.max(0, Math.floor(width)))+ text

function render() {
  const { cols, rows } = size()
  const lines: string[] = []

  // Header: wordmark centred, or the compact name when it will not fit.
  const wide = cols >= WORDMARK_WIDTH + 4
  const art = wide ? WORDMARK : [COMPACT]
  const artWidth = wide ? WORDMARK_WIDTH : COMPACT.length
  const gutter = (cols - artWidth) / 2

  lines.push("")
  for (const row of art) lines.push(theme.goblin + pad(row, gutter) + ansi.reset)
  lines.push("")
  lines.push(theme.gold + pad("your local AI goblin for code, images and agents", (cols - 47) / 2) + ansi.reset)
  lines.push("")

  // Body: empty for now. This is where the transcript will render.
  const composerHeight = 5
  const used = lines.length + composerHeight + 2
  for (let i = 0; i < Math.max(0, rows - used); i++) lines.push("")

  // Composer: a thin bar, matching the previous TUI's shape.
  const inner = Math.max(10, cols - 4)
  const shown = input || `${dim}ask the goblin anything…${ansi.reset}${theme.text}`
  lines.push(theme.border + "  " + "─".repeat(inner) + ansi.reset)
  lines.push(theme.goblin + "  │ " + ansi.reset + theme.text + shown + ansi.reset)
  lines.push(theme.border + "  " + "─".repeat(inner) + ansi.reset)

  // Status line. Measure the visible text, not the escape codes.
  const leftText = "tab modes   ctrl+g actions"
  const rightText = "not wired yet"
  const gap = Math.max(1, cols - 4 - leftText.length - rightText.length)
  lines.push(
    "  " + dim + leftText + ansi.reset + " ".repeat(gap) + theme.muted + rightText + ansi.reset,
  )

  out.write(ansi.clear + lines.join("\n"))
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
  const key = chunk.toString()
  if (key === "\x03" || key === "\x1b") return shutdown() // ctrl+c / esc
  if (key === "\x7f") input = input.slice(0, -1)          // backspace
  else if (key >= " " && key <= "~") input += key
  render()
})

process.on("SIGINT", shutdown)
process.on("SIGTERM", shutdown)
