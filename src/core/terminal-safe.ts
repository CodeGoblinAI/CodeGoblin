/**
 * Text that is safe to put on a terminal.
 *
 * A terminal obeys what it is sent. Among the codes it obeys are ones that set the clipboard (OSC 52), set
 * the window title, hide text, move the cursor and clear the screen. A model's answer, a file a tool read, a
 * command's output, a pasted line and a conversation's title are all text from somewhere else, and all of
 * them were drawn as they came - so a web page or a file that a model repeated could replace what is on the
 * clipboard, or hide part of a command in the very box that asks whether to run it.
 *
 * Two guards, because there are dozens of places text comes in and one place it goes out:
 *
 * - `visibleControls` is for text as it arrives: every control character becomes something that can be seen
 *   and does nothing. An escape shows as a small "ESC" sign.
 * - `frameSafe` is for a finished line on its way to the screen, which also carries the app's own colour
 *   codes. It lets through colour and style and nothing else - and of style, not "conceal".
 */
const ESC = String.fromCharCode(27)
const SHOWN_ESCAPE = String.fromCharCode(0x241b)

function isControl(code: number): boolean {
  // Tab and newline are layout; everything else below a space, delete, and the 8-bit controls are not text.
  return (code < 32 && code !== 9 && code !== 10) || code === 127 || (code >= 128 && code <= 159)
}

/** Untrusted text with its control characters made visible and harmless. Carriage returns are dropped. */
export function visibleControls(text: string): string {
  let clean = true
  for (let at = 0; at < text.length; at++) if (isControl(text.charCodeAt(at))) { clean = false; break }
  if (clean) return text
  let out = ""
  for (const char of text) {
    const code = char.charCodeAt(0)
    if (char.length > 1 || !isControl(code)) out += char
    else if (code === 27 || code === 155) out += SHOWN_ESCAPE
    // The rest (bell, backspace, carriage return, and so on) have nothing worth showing.
  }
  return out
}

/**
 * Characters that change the order text is drawn in (bidirectional overrides and isolates). A browser obeys
 * them, and so do some terminals: `rm -rf ~ #` followed by a right-to-left override can be drawn as something
 * else entirely ("Trojan Source"). In what a call asks to run they are only ever a trick, so they are named.
 */
const REORDERING = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g

/** What a tool call asks to do, made safe to show for approval: controls visible, reordering marks named. */
export function visibleCall(text: string): string {
  return visibleControls(text).replace(REORDERING, (mark) => "<U+" + mark.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0") + ">")
}

/** The parameters of a colour/style code with "conceal" taken out. A colour's own numbers are left alone. */
function withoutConceal(params: string): string {
  const parts = params.split(";")
  const kept: string[] = []
  for (let at = 0; at < parts.length; at++) {
    const part = parts[at]!
    // 38, 48 and 58 start an extended colour: "5;n" or "2;r;g;b" follow and are numbers, not styles.
    if (part === "38" || part === "48" || part === "58") {
      const take = parts[at + 1] === "5" ? 2 : parts[at + 1] === "2" ? 4 : 0
      kept.push(...parts.slice(at, at + 1 + take))
      at += take
      continue
    }
    if (part === "8") continue
    kept.push(part)
  }
  return kept.join(";")
}

/**
 * A line ready for the screen, with only colour and style codes left in it. Everything else that begins with
 * an escape is removed whole - clipboard and title codes with their contents, cursor moves, screen clears -
 * and so is every other control character. Text is never changed.
 */
export function frameSafe(line: string): string {
  // Nothing to look at in a line with no escape and no control character in it.
  let needs = false
  for (let at = 0; at < line.length; at++) { const code = line.charCodeAt(at); if (code === 27 || isControl(code)) { needs = true; break } }
  if (!needs) return line
  let out = ""
  for (let at = 0; at < line.length; at++) {
    const char = line[at]!
    const code = char.charCodeAt(0)
    if (code !== 27) { if (!isControl(code)) out += char; continue }
    const next = line[at + 1]
    if (next === "[") {
      // A control sequence: parameters, then one final letter. Kept only when that letter is "m".
      let end = at + 2
      while (end < line.length && /[0-9:;<=>?]/.test(line[end]!)) end++
      while (end < line.length && /[ -\/]/.test(line[end]!)) end++
      const params = line.slice(at + 2, end)
      // A code that was only "conceal" goes whole; left empty it would be a reset.
      const kept = line[end] === "m" && /^[0-9;]*$/.test(params) ? withoutConceal(params) : undefined
      if (kept !== undefined && (kept || !params)) out += ESC + "[" + kept + "m"
      at = Math.min(end, line.length - 1)
      continue
    }
    if (next === "]" || next === "P" || next === "_" || next === "^" || next === "X") {
      // A string code (clipboard, title, and their kin): gone up to its terminator, or to the end of the line.
      let end = at + 2
      while (end < line.length && line.charCodeAt(end) !== 7 && !(line.charCodeAt(end) === 27 && line[end + 1] === "\\") && line.charCodeAt(end) !== 156) end++
      at = end < line.length && line.charCodeAt(end) === 27 ? end + 1 : end
      continue
    }
    // Any other escape: it and the character it applies to.
    at++
  }
  return out
}
