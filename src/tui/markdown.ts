import { theme, dim, bold, ansi } from "./ansi"
import { displayWidth, truncateToWidth, padToWidth } from "./width"

/**
 * Markdown for a terminal.
 *
 * Agents answer in markdown, so rendering it plainly makes every reply with a
 * code block look like noise. This covers what actually shows up in answers:
 * fenced code, inline code, bold, headings, list bullets and tables.
 */
export function renderMarkdown(text: string, width: number): string[] {
  const out: string[] = []
  const rows = text.split(String.fromCharCode(10))
  let inCode = false
  let codeLang = ""

  for (let index = 0; index < rows.length; index++) {
    const raw = rows[index]!
    const fence = raw.trimStart().startsWith("```")

    if (fence) {
      if (!inCode) {
        inCode = true
        codeLang = raw.trim().slice(3).trim()
        // The top edge runs as far as the bottom one, so the block reads as a box and not a stray corner.
        const label = "─ " + (codeLang || "code") + " "
        out.push(theme.border + "  ┌─ " + theme.muted + (codeLang || "code") + theme.border + " " + "─".repeat(Math.max(0, Math.max(2, Math.min(width, 40)) - label.length)) + ansi.reset)
      } else {
        inCode = false
        out.push(theme.border + "  └" + "─".repeat(Math.max(2, Math.min(width, 40))) + ansi.reset)
      }
      continue
    }

    if (inCode) {
      // Code is shown verbatim; wrapping it would corrupt the meaning.
      for (const piece of hardWrap(raw, width - 4)) {
        out.push(theme.border + "  │ " + ansi.reset + theme.gold + piece + ansi.reset)
      }
      continue
    }

    if (!raw.trim()) { out.push(""); continue }

    // A table is only a table if the row under it is the alignment rule -
    // otherwise a sentence containing two pipes would be drawn as a grid.
    if (isTableRow(raw) && isAlignmentRow(rows[index + 1])) {
      let end = index
      while (end < rows.length && isTableRow(rows[end]!)) end++
      out.push(...renderTable(rows.slice(index, end), width))
      index = end - 1
      continue
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(raw)
    if (heading) {
      for (const piece of wrapWords(heading[2]!, width)) out.push(bold + theme.text + piece + ansi.reset)
      continue
    }

    const bullet = /^\s*[-*]\s+(.*)$/.exec(raw)
    if (bullet) {
      const pieces = wrapWords(bullet[1]!, width - 4)
      out.push(theme.goblin + "  • " + ansi.reset + inline(pieces[0] ?? ""))
      for (const piece of pieces.slice(1)) out.push("    " + inline(piece))
      continue
    }

    for (const piece of wrapWords(raw, width)) out.push(inline(piece))
  }

  return out
}

const isTableRow = (line?: string) => line !== undefined && /^\s*\|.*\|\s*$/.test(line)

/** The |---|:--:|---:| rule under a header, which is what makes a table one. */
const isAlignmentRow = (line?: string) =>
  line !== undefined && /^\s*\|(?:\s*:?-+:?\s*\|)+\s*$/.test(line)

/**
 * Cells of one row.
 *
 * An escaped pipe is left alone: \| inside a cell is content, and splitting on
 * it would cut a cell in half.
 */
const PIPE = String.fromCharCode(124)
function cellsOf(line: string): string[] {
  const inner = line.trim().replace(/^\|/, "").replace(/\|$/, "")
  return inner
    .split(/(?<!\\)\|/)
    .map((cell) => cell.trim().split(String.fromCharCode(92) + PIPE).join(PIPE))
}

/**
 * A markdown table, drawn as one.
 *
 * Models answer with tables constantly - two arrived in the first reply anyone
 * asked for - and without this they landed as rows of raw pipes and dashes,
 * which is worse than plain prose because the reader has to do the aligning.
 *
 * Columns take their natural width and are shrunk, widest first, until the
 * table fits the pane. Cells that no longer fit are truncated rather than
 * wrapped: a wrapped cell makes rows different heights, and at that point the
 * grid stops being readable at a glance, which was the only reason to draw it.
 */
function renderTable(lines: string[], width: number): string[] {
  const header = cellsOf(lines[0]!)
  const alignments = cellsOf(lines[1]!).map((spec) =>
    spec.startsWith(":") && spec.endsWith(":") ? "centre" : spec.endsWith(":") ? "right" : "left",
  )
  const body = lines.slice(2).map(cellsOf)
  const columns = Math.max(header.length, ...body.map((row) => row.length), 1)

  const cell = (row: string[], column: number) => row[column] ?? ""
  const widths = Array.from({ length: columns }, (_, column) =>
    Math.max(1, displayWidth(cell(header, column)), ...body.map((row) => displayWidth(cell(row, column)))),
  )

  // "  " indent, then "| cell " per column, then the closing "|".
  const spent = () => 3 + widths.reduce((total, each) => total + each + 3, 0)
  while (spent() > width) {
    const widest = widths.indexOf(Math.max(...widths))
    if (widths[widest]! <= 3) break
    widths[widest]!--
  }

  const fit = (text: string, column: number) => {
    const room = widths[column]!
    // An ellipsis where a cell was cut, so a value that ends mid-word reads as
    // shortened rather than as what the table actually holds.
    const clipped =
      displayWidth(text) > room ? truncateToWidth(text, Math.max(0, room - 1)) + "…" : text
    const slack = room - displayWidth(clipped)
    if (alignments[column] === "right") return " ".repeat(slack) + clipped
    if (alignments[column] === "centre") {
      const left = Math.floor(slack / 2)
      return " ".repeat(left) + clipped + " ".repeat(slack - left)
    }
    return padToWidth(clipped, room)
  }

  const rule = (left: string, join: string, right: string) =>
    theme.border + "  " + left + widths.map((each) => "─".repeat(each + 2)).join(join) + right + ansi.reset

  const line = (row: string[], emphasis: string) =>
    theme.border +
    "  │ " +
    widths.map((_, column) => emphasis + fit(cell(row, column), column) + ansi.reset).join(theme.border + " │ ") +
    theme.border +
    " │" +
    ansi.reset

  return [
    rule("┌", "┬", "┐"),
    line(header, bold + theme.text),
    rule("├", "┼", "┤"),
    ...body.map((row) => line(row, theme.text)),
    rule("└", "┴", "┘"),
  ]
}

/** Inline code and bold, applied after wrapping so widths stay honest. */
function inline(text: string): string {
  let result = text.replace(/`([^`]+)`/g, (_, code) => theme.gold + code + ansi.reset + theme.text)
  result = result.replace(/\*\*([^*]+)\*\*/g, (_, strong) => bold + strong + ansi.reset + theme.text)
  return theme.text + result + ansi.reset
}

function wrapWords(text: string, width: number): string[] {
  if (width < 8) return [text]
  const lines: string[] = []
  let line = ""
  for (const word of text.split(" ")) {
    if (line && displayWidth(line + " " + word) > width) { lines.push(line); line = word }
    else line = line ? line + " " + word : word
  }
  if (line) lines.push(line)
  return lines.length ? lines : [""]
}

function hardWrap(text: string, width: number): string[] {
  if (width < 8 || text.length <= width) return [text]
  const lines: string[] = []
  for (let i = 0; i < text.length; i += width) lines.push(text.slice(i, i + width))
  return lines
}
