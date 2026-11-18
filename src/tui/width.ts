/**
 * Display width, not string length.
 *
 * A terminal cell is not a JavaScript character. CJK and emoji occupy two
 * columns, combining marks occupy none, and emoji are often two UTF-16 code
 * units besides. Measuring with .length lets a line that looks short overflow
 * the terminal and wrap, which shifts everything below it.
 */

const WIDE_RANGES: [number, number][] = [
  [0x1100, 0x115f], // Hangul Jamo
  [0x2e80, 0x303e], // CJK radicals, Kangxi
  [0x3041, 0x33ff], // Hiragana, Katakana, CJK compatibility
  [0x3400, 0x4dbf], // CJK Extension A
  [0x4e00, 0x9fff], // CJK Unified Ideographs
  [0xa000, 0xa4cf], // Yi
  [0xac00, 0xd7a3], // Hangul Syllables
  [0xf900, 0xfaff], // CJK Compatibility Ideographs
  [0xfe30, 0xfe6f], // CJK Compatibility Forms
  [0xff00, 0xff60], // Fullwidth Forms
  [0xffe0, 0xffe6],
  [0x1f300, 0x1f64f], // emoji
  [0x1f680, 0x1f6ff], // transport and map emoji
  [0x1f900, 0x1f9ff],
  [0x1fa70, 0x1faff], // extended emoji
  [0x20000, 0x3fffd], // CJK Extension B+
]

const ZERO_RANGES: [number, number][] = [
  [0x0300, 0x036f], // combining diacritics
  [0x200b, 0x200f], // zero-width spaces and marks
  [0xfe00, 0xfe0f], // variation selectors
]

function inRanges(code: number, ranges: [number, number][]): boolean {
  for (const [low, high] of ranges) if (code >= low && code <= high) return true
  return false
}

export function charWidth(char: string): number {
  const code = char.codePointAt(0) ?? 0
  if (code === 0) return 0
  if (inRanges(code, ZERO_RANGES)) return 0
  if (inRanges(code, WIDE_RANGES)) return 2
  return 1
}

/** Width of a string, ignoring any ANSI escape sequences inside it. */
export function displayWidth(text: string): number {
  let width = 0
  let index = 0
  const chars = [...text]

  while (index < chars.length) {
    if (chars[index]!.charCodeAt(0) === 27) {
      while (index < chars.length && !/[a-zA-Z]/.test(chars[index]!)) index++
      index++
      continue
    }
    width += charWidth(chars[index]!)
    index++
  }
  return width
}

/** Truncate to a display width, preserving escape sequences. */
export function truncateToWidth(text: string, max: number): string {
  let width = 0
  let result = ""
  const chars = [...text]
  let index = 0

  while (index < chars.length) {
    if (chars[index]!.charCodeAt(0) === 27) {
      let escape = ""
      while (index < chars.length && !/[a-zA-Z]/.test(chars[index]!)) escape += chars[index++]
      if (index < chars.length) escape += chars[index++]
      result += escape
      continue
    }
    const next = charWidth(chars[index]!)
    if (width + next > max) break
    result += chars[index]
    width += next
    index++
  }
  return result
}

/** Pad to a display width; padEnd counts characters, which is not the same. */
export function padToWidth(text: string, target: number): string {
  const gap = target - displayWidth(text)
  return gap > 0 ? text + " ".repeat(gap) : text
}

/** Pad on the left to a display width, for text that sits against the right edge. */
export function padStartToWidth(text: string, target: number): string {
  const gap = target - displayWidth(text)
  return gap > 0 ? " ".repeat(gap) + text : text
}

/** Plain text broken into lines of at most max columns, at spaces where it can be. */
export function wrapToWidth(text: string, max: number): string[] {
  if (max < 1 || displayWidth(text) <= max) return [text]
  const lines: string[] = []
  let line = ""
  for (const word of text.split(" ")) {
    const candidate = line ? line + " " + word : word
    if (displayWidth(candidate) <= max) {
      line = candidate
      continue
    }
    if (line) lines.push(line)
    // A word longer than the line is cut, since there is no space to break it at.
    let rest = word
    while (displayWidth(rest) > max) {
      const piece = truncateToWidth(rest, max)
      if (!piece) {
        const first = [...rest][0]!
        lines.push(first)
        rest = rest.slice(first.length)
        continue
      }
      lines.push(piece)
      rest = rest.slice(piece.length)
    }
    line = rest
  }
  if (line) lines.push(line)
  return lines
}

/**
 * Shorten plain text to a display width by cutting out of the middle, so both ends stay readable.
 * Model names differ at the end ("... Abliterated Fast", "... (free route)"), which a cut from the right loses.
 */
export function truncateMiddle(text: string, max: number): string {
  if (displayWidth(text) <= max) return text
  if (max <= 1) return max === 1 ? "…" : ""
  const chars = [...text]
  const tailRoom = Math.floor((max - 1) / 2)
  let tail = ""
  for (let index = chars.length - 1; index >= 0 && displayWidth(chars[index]! + tail) <= tailRoom; index--) tail = chars[index]! + tail
  return truncateToWidth(text, max - 1 - displayWidth(tail)) + "…" + tail
}

/**
 * Plain text from display column `startCol` onward. If a two-column character straddles `startCol`,
 * its right-hand cell becomes a space so the remainder still begins on `startCol`.
 */
export function sliceFromWidth(text: string, startCol: number): string {
  if (startCol <= 0) return text
  let col = 0
  const chars = [...text]
  let index = 0
  let lead = ""
  while (index < chars.length) {
    const w = charWidth(chars[index]!)
    if (w === 0) {
      if (col > startCol) break
      index++
      continue
    }
    if (col >= startCol) break
    if (col + w > startCol) {
      lead = " ".repeat(col + w - startCol)
      col += w
      index++
      break
    }
    col += w
    index++
  }
  return lead + chars.slice(index).join("")
}
