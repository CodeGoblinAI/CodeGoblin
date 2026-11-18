import { charWidth, displayWidth } from "./width"

/**
 * The prompt as a small editor.
 *
 * It used to be a string and a caret: no way to move by word, no way to select
 * anything, and ctrl+u wiping the line as the only delete larger than one
 * character. The original treats the prompt as an editor with about a dozen
 * commands, which is why fixing one word there does not mean retyping the
 * sentence.
 *
 * Kept apart from the app so it can be tested without a terminal. Everything
 * here is pure: a state goes in, a state comes out.
 */

export type Composer = {
  text: string
  cursor: number
  /**
   * Where a selection started, if one is running.
   *
   * The selected span is between this and the cursor, in either direction -
   * holding the anchor rather than a sorted range is what lets shift+left
   * after shift+right shrink the selection instead of starting a new one.
   */
  anchor?: number
}

export const empty: Composer = { text: "", cursor: 0 }

/** The selected span, low to high, or nothing. */
export function selection(state: Composer): { from: number; to: number } | undefined {
  if (state.anchor === undefined || state.anchor === state.cursor) return undefined
  return {
    from: Math.min(state.anchor, state.cursor),
    to: Math.max(state.anchor, state.cursor),
  }
}

export function selectedText(state: Composer): string {
  const span = selection(state)
  return span ? state.text.slice(span.from, span.to) : ""
}

const isWordChar = (char: string | undefined) => char !== undefined && /[\p{L}\p{N}_]/u.test(char)

/**
 * The start of the word before an offset.
 *
 * Skips whatever separators sit immediately behind the caret first, so
 * ctrl+left from the end of "one two   " lands before "two", not in the gap.
 */
export function wordStart(text: string, from: number): number {
  let at = from
  while (at > 0 && !isWordChar(text[at - 1])) at--
  while (at > 0 && isWordChar(text[at - 1])) at--
  return at
}

export function wordEnd(text: string, from: number): number {
  let at = from
  while (at < text.length && !isWordChar(text[at])) at++
  while (at < text.length && isWordChar(text[at])) at++
  return at
}

type Move = { to: number; select: boolean }

/** Move the caret, extending or dropping the selection as asked. */
export function moveTo(state: Composer, { to, select }: Move): Composer {
  const cursor = Math.max(0, Math.min(to, state.text.length))
  if (!select) return { text: state.text, cursor }
  // Starting a selection anchors where the caret was, not where it lands.
  return { text: state.text, cursor, anchor: state.anchor ?? state.cursor }
}

/** Replace the selection, or insert at the caret when there is none. */
export function insert(state: Composer, value: string): Composer {
  const span = selection(state)
  if (span) {
    const text = state.text.slice(0, span.from) + value + state.text.slice(span.to)
    return { text, cursor: span.from + value.length }
  }
  const text = state.text.slice(0, state.cursor) + value + state.text.slice(state.cursor)
  return { text, cursor: state.cursor + value.length }
}

/**
 * Where the character before or after the cursor starts, whole. An emoji is two
 * UTF-16 units, and stepping by one split it: backspace over 🧌 left half of it
 * behind as a broken character.
 */
export function charBefore(text: string, cursor: number): number {
  if (cursor <= 0) return 0
  const low = text.charCodeAt(cursor - 1)
  const high = text.charCodeAt(cursor - 2)
  return low >= 0xdc00 && low <= 0xdfff && high >= 0xd800 && high <= 0xdbff ? cursor - 2 : cursor - 1
}

export function charAfter(text: string, cursor: number): number {
  if (cursor >= text.length) return text.length
  const high = text.charCodeAt(cursor)
  const low = text.charCodeAt(cursor + 1)
  return high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff ? cursor + 2 : cursor + 1
}

/**
 * Delete.
 *
 * A selection goes first, whichever key was pressed - which is the behaviour
 * that was missing: highlight several words, press backspace, lose exactly
 * those words rather than the whole line or one character.
 */
export function deleteRange(state: Composer, kind: "back" | "forward" | "wordBack" | "wordForward" | "toEnd" | "toStart"): Composer {
  const span = selection(state)
  if (span) {
    return { text: state.text.slice(0, span.from) + state.text.slice(span.to), cursor: span.from }
  }

  const { text, cursor } = state
  if (kind === "back") {
    if (cursor === 0) return state
    const at = charBefore(text, cursor)
    return { text: text.slice(0, at) + text.slice(cursor), cursor: at }
  }
  if (kind === "forward") {
    if (cursor >= text.length) return state
    return { text: text.slice(0, cursor) + text.slice(charAfter(text, cursor)), cursor }
  }
  if (kind === "wordBack") {
    const at = wordStart(text, cursor)
    return { text: text.slice(0, at) + text.slice(cursor), cursor: at }
  }
  if (kind === "wordForward") {
    const at = wordEnd(text, cursor)
    return { text: text.slice(0, cursor) + text.slice(at), cursor }
  }
  if (kind === "toEnd") return { text: text.slice(0, cursor), cursor }
  return { text: text.slice(cursor), cursor: 0 }
}

export function selectAll(state: Composer): Composer {
  return { text: state.text, cursor: state.text.length, anchor: 0 }
}

/**
 * Undo for the prompt itself.
 *
 * Separate from /undo, which is about files. Losing a paragraph to a
 * mis-aimed ctrl+u and having no way back is its own small misery.
 */
export class ComposerHistory {
  private past: Composer[] = []
  private future: Composer[] = []
  private readonly limit = 50

  /** Called before a change, so the state being replaced is what comes back. */
  remember(state: Composer) {
    const last = this.past[this.past.length - 1]
    if (last && last.text === state.text) return
    this.past.push({ text: state.text, cursor: state.cursor })
    if (this.past.length > this.limit) this.past.shift()
    this.future = []
  }

  undo(current: Composer): Composer | undefined {
    const previous = this.past.pop()
    if (!previous) return undefined
    this.future.push({ text: current.text, cursor: current.cursor })
    return previous
  }

  redo(current: Composer): Composer | undefined {
    const next = this.future.pop()
    if (!next) return undefined
    this.past.push({ text: current.text, cursor: current.cursor })
    return next
  }

  reset() {
    this.past = []
    this.future = []
  }
}

export type ComposerLine = {
  /** Drawn text for this visual row (never contains \n). */
  text: string
  /** UTF-16 start index in Composer.text. */
  start: number
  /** UTF-16 end index in Composer.text (exclusive; text.slice(start, end) === row.text). */
  end: number
  /** True when the next row continues the same paragraph without a consumed break character. */
  soft: boolean
}

function layoutParagraph(para: string, paraStart: number, limit: number): ComposerLine[] {
  if (!para.length) return [{ text: "", start: paraStart, end: paraStart, soft: false }]
  const rows: ComposerLine[] = []
  let rowText = ""
  let rowStart = paraStart
  let rowEnd = paraStart
  let rowWidth = 0

  for (const match of para.matchAll(/\s+|\S+/gu)) {
    const token = match[0]
    if (/^\s+$/u.test(token)) {
      for (const ch of [...token]) {
        const w = charWidth(ch)
        if (rowText.length > 0 && rowWidth + w > limit) {
          // A space right at the margin breaks the line cleanly so the next line does not start indented.
          if (rowWidth === limit && rowText.trim().length > 0) {
            rows.push({ text: rowText, start: rowStart, end: rowEnd, soft: false })
            rowStart = rowEnd + ch.length
            rowEnd = rowStart
            rowText = ""
            rowWidth = 0
          } else {
            rows.push({ text: rowText, start: rowStart, end: rowEnd, soft: true })
            rowStart = rowEnd
            rowText = ch
            rowEnd += ch.length
            rowWidth = w
          }
        } else {
          rowText += ch
          rowEnd += ch.length
          rowWidth += w
        }
      }
      continue
    }

    const wordWidth = displayWidth(token)
    if (rowWidth + wordWidth <= limit) {
      rowText += token
      rowEnd += token.length
      rowWidth += wordWidth
      continue
    }
    if (wordWidth <= limit) {
      rows.push({ text: rowText, start: rowStart, end: rowEnd, soft: true })
      rowStart = rowEnd
      rowText = token
      rowEnd = rowStart + token.length
      rowWidth = wordWidth
      continue
    }
    if (rowText.length > 0) {
      rows.push({ text: rowText, start: rowStart, end: rowEnd, soft: true })
      rowStart = rowEnd
      rowText = ""
      rowWidth = 0
    }
    for (const ch of [...token]) {
      const w = charWidth(ch)
      if (rowText.length > 0 && rowWidth + w > limit) {
        rows.push({ text: rowText, start: rowStart, end: rowEnd, soft: true })
        rowStart = rowEnd
        rowText = ch
        rowEnd += ch.length
        rowWidth = w
      } else {
        rowText += ch
        rowEnd += ch.length
        rowWidth += w
      }
    }
  }

  rows.push({ text: rowText, start: rowStart, end: rowEnd, soft: false })
  return rows
}

/**
 * Word-wraps the composer text into visual rows of at most `width` display columns,
 * honouring explicit `\n` line breaks and keeping exact UTF-16 offsets into `text`.
 */
export function layoutComposer(text: string, width: number): ComposerLine[] {
  const limit = Math.max(1, width)
  if (!text.length) return [{ text: "", start: 0, end: 0, soft: false }]
  const rows: ComposerLine[] = []
  let offset = 0
  const parts = text.split("\n")
  for (const part of parts) {
    rows.push(...layoutParagraph(part, offset, limit))
    offset += part.length + 1
  }
  return rows
}

/** Which wrapped visual row `cursor` sits on, and its display column from the left edge of that row. */
export function caretInComposer(rows: ComposerLine[], cursor: number): { line: number; column: number } {
  const clamped = Math.max(0, cursor)
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index]!
    const inside = row.soft ? clamped < row.end : clamped <= row.end
    if (inside || index === rows.length - 1) {
      const sliceEnd = Math.max(0, Math.min(clamped - row.start, row.text.length))
      return { line: index, column: displayWidth(row.text.slice(0, sliceEnd)) }
    }
  }
  return { line: 0, column: 0 }
}

/** UTF-16 offset in `Composer.text` corresponding to 0-based `targetColumn` on `row`. */
export function offsetInComposerLine(row: ComposerLine, targetColumn: number): number {
  if (targetColumn <= 0 || !row.text.length) return row.start
  let utf16 = 0
  let col = 0
  for (const ch of [...row.text]) {
    const w = charWidth(ch)
    if (w > 0 && targetColumn < col + w) return row.start + utf16
    utf16 += ch.length
    col += w
  }
  // A soft-wrapped row's `end` is the start of the next row; stay before its last character so the caret stays on this row.
  return row.soft ? row.start + charBefore(row.text, row.text.length) : row.end
}

/** Move up or down one visual line inside a multi-line/wrapped composer, or undefined at the top/bottom edge. */
export function moveLine(state: Composer, width: number, direction: -1 | 1, select = false): Composer | undefined {
  const rows = layoutComposer(state.text, width)
  if (rows.length <= 1) return undefined
  const spot = caretInComposer(rows, state.cursor)
  const target = spot.line + direction
  if (target < 0 || target >= rows.length) return undefined
  return moveTo(state, { to: offsetInComposerLine(rows[target]!, spot.column), select })
}

/** Home/End within a wrapped composer: moves to the current visual line's edge first, then the whole prompt's edge. */
export function lineEdge(rows: ComposerLine[], cursor: number, edge: "start" | "end"): number {
  const spot = caretInComposer(rows, cursor)
  const row = rows[spot.line]!
  if (edge === "start") return cursor !== row.start ? row.start : 0
  const end = row.soft && row.text.length > 0 ? row.start + charBefore(row.text, row.text.length) : row.end
  return cursor !== end ? end : (rows.at(-1)?.end ?? cursor)
}
