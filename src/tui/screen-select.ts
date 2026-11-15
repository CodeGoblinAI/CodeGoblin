import { charWidth } from "./width"

/**
 * Selecting text on the screen with the mouse.
 *
 * The app takes the mouse - that is what makes the wheel scroll the conversation and the toolbar clickable -
 * and a terminal that has given its mouse away no longer selects text itself. So dragging over an answer did
 * nothing, and the only way to copy a line was to know that shift+drag asks the terminal for its own
 * selection. Here a drag selects what is under it, as a terminal would, and letting go copies it.
 *
 * It works on the frame as drawn: rows of text, one column per cell (two for a wide character).
 */
export type Cell = { row: number; col: number }
export type Span = { from: Cell; to: Cell }

const ESCAPE = String.fromCharCode(27)
/** The bar an answer is drawn behind, or the rule beside a command's output, with the space after it. */
const GUTTER = /^ *[|│┃▏] ?/

/** A drawn line as its cells: the character in each column, with a wide character's second column empty. */
export function cellsOf(line: string): string[] {
  const cells: string[] = []
  const chars = [...line]
  for (let index = 0; index < chars.length; index++) {
    const char = chars[index]!
    if (char === ESCAPE) {
      // CSI: up to its final letter. Anything else that starts with escape is two characters.
      if (chars[index + 1] === "[") { index += 2; while (index < chars.length && !/[A-Za-z~]/.test(chars[index]!)) index++ }
      else index++
      continue
    }
    const width = charWidth(char)
    if (width === 0) { if (cells.length) cells[cells.length - 1] += char; continue }
    cells.push(char)
    if (width === 2) cells.push("")
  }
  return cells
}

/** The span with its start before its end, whichever way it was dragged. */
export function ordered(span: Span): Span {
  const { from, to } = span
  return from.row < to.row || (from.row === to.row && from.col <= to.col) ? span : { from: to, to: from }
}

export const isEmpty = (span: Span) => span.from.row === span.to.row && span.from.col === span.to.col

/** The columns a span covers on each row it touches (1-based, inclusive), cut to what is drawn there. */
export function rowsOf(frame: string[], span: Span): { row: number; from: number; to: number; text: string }[] {
  const { from, to } = ordered(span)
  const rows: { row: number; from: number; to: number; text: string }[] = []
  for (let row = Math.max(1, from.row); row <= Math.min(frame.length, to.row); row++) {
    const cells = cellsOf(frame[row - 1] ?? "")
    // Past the end of the text there is nothing to take; a row selected whole is its text.
    const drawn = cells.join("").trimEnd() ? cells.length - (/\s*$/.exec(cells.join(""))?.[0].length ?? 0) : 0
    let first = row === from.row ? from.col : 1
    let last = Math.min(row === to.row ? to.col : cells.length, cells.length)
    // Starting on the second half of a wide character takes the whole character.
    if (first > 1 && cells[first - 1] === "") first--
    if (last < first) { rows.push({ row, from: first, to: first - 1, text: "" }); continue }
    rows.push({ row, from: first, to: Math.min(last, Math.max(drawn, first - 1)), text: cells.slice(first - 1, last).join("") })
  }
  return rows
}

/**
 * The text of a selection: each row without its trailing blanks, and without the margin the rows share -
 * the conversation is drawn indented, and nobody wants the indent in what they paste.
 */
export function textOf(frame: string[], span: Span): string {
  const rows = rowsOf(frame, span)
  let lines = rows.map((row) => row.text.trimEnd())
  // An answer is drawn behind a bar and a command's output behind a rule. When every row taken from its
  // left edge starts with one, it is the app's drawing, not the text.
  const whole = lines.filter((_, index) => index > 0 || rows[index]!.from <= 3)
  if (lines.length > 1 && whole.length && whole.every((line) => GUTTER.test(line))) {
    lines = lines.map((line, index) => (index > 0 || rows[index]!.from <= 3 ? line.replace(GUTTER, "") : line))
  }
  while (lines.length && !lines.at(-1)!.trim()) lines.pop()
  while (lines.length && !lines[0]!.trim()) lines.shift()
  if (lines.length > 1) {
    const margin = Math.min(...lines.filter((line) => line.trim()).map((line) => /^ */.exec(line)![0].length))
    if (margin > 0) return lines.map((line) => line.slice(margin)).join("\n")
  }
  return lines.join("\n")
}

/** What to write after a frame so the selected cells show as selected: each row's text again, in `colour`. */
export function paint(frame: string[], span: Span, colour: string, reset: string): string {
  let out = ""
  for (const row of rowsOf(frame, span)) {
    if (row.to < row.from) continue
    const cells = cellsOf(frame[row.row - 1] ?? "")
    out += `${ESCAPE}[${row.row};${row.from}H` + colour + cells.slice(row.from - 1, row.to).join("") + reset
  }
  return out
}
