/**
 * Terminal key parsing.
 *
 * Terminals send escape sequences, not keys: Up is ESC [ A, three bytes. Code
 * that compares against a bare ESC therefore treats every arrow press as
 * Escape - which is why pressing Up used to quit the app.
 *
 * A chunk can also carry several keys at once (fast typing, paste), so this
 * returns a list rather than a single key.
 */
export type Key =
  | { type: "char"; value: string }
  | { type: "enter" }
  | { type: "backspace" }
  | { type: "delete" }
  | { type: "up"; shift?: boolean; ctrl?: boolean }
  | { type: "down"; shift?: boolean; ctrl?: boolean }
  | { type: "left"; shift?: boolean; ctrl?: boolean }
  | { type: "right"; shift?: boolean; ctrl?: boolean }
  | { type: "home"; shift?: boolean; ctrl?: boolean }
  | { type: "end"; shift?: boolean; ctrl?: boolean }
  | { type: "pageup" }
  | { type: "pagedown" }
  | { type: "wheelup" }
  | { type: "wheeldown" }
  | { type: "click"; col: number; row: number }
  | { type: "shifttab" }
  | { type: "shiftup" }
  | { type: "shiftdown" }
  | { type: "paste"; value: string }
  | { type: "escape" }
  | { type: "ctrl"; value: string }

const CSI: Record<string, Key["type"]> = {
  A: "up",
  B: "down",
  C: "right",
  D: "left",
  H: "home",
  F: "end",
  // CSI Z is shift+tab, which cycles the permission mode.
  Z: "shifttab",
}

const TILDE: Record<string, Key["type"]> = {
  "1": "home",
  "3": "delete",
  "4": "end",
  "5": "pageup",
  "6": "pagedown",
  "7": "home",
  "8": "end",
}

const ESCAPE = String.fromCharCode(27)
const PASTE_START = "[200~"
const PASTE_END = "[201~"
const PASTE_OPEN = ESCAPE + PASTE_START
const PASTE_CLOSE = ESCAPE + PASTE_END

/**
 * Reads keys across chunk boundaries.
 *
 * A big paste does not arrive in one piece - stdin hands it over in several
 * chunks, and parseKeys sees only one at a time. The opening ESC[200~ landed
 * in the first chunk with no terminator anywhere in it, so everything after
 * it was read as ordinary typing: newlines included, and every newline is an
 * enter. Pasting a long block therefore submitted it, repeatedly, in pieces.
 *
 * So the paste state lives here, between chunks, and the text is only handed
 * on once its closing marker actually arrives.
 */
export function createKeyReader(): (chunk: string) => Key[] {
  let pasting: string | undefined

  return function read(chunk: string): Key[] {
    if (pasting !== undefined) {
      const end = chunk.indexOf(PASTE_CLOSE)
      if (end === -1) {
        pasting += chunk
        return []
      }
      const value = pasting + chunk.slice(0, end)
      pasting = undefined
      return [{ type: "paste", value }, ...read(chunk.slice(end + PASTE_CLOSE.length))]
    }

    const start = chunk.indexOf(PASTE_OPEN)
    if (start !== -1 && chunk.indexOf(PASTE_CLOSE, start) === -1) {
      // Opened but not closed in this chunk: keep the rest until it is.
      pasting = chunk.slice(start + PASTE_OPEN.length)
      return parseKeys(chunk.slice(0, start))
    }

    return parseKeys(chunk)
  }
}
export function parseKeys(input: string): Key[] {
  const keys: Key[] = []
  let i = 0

  while (i < input.length) {
    const char = input[i]!
    const code = char.charCodeAt(0)

    // Escape sequence, or a bare Escape if nothing follows it.
    if (code === 27) {
      // A bracketed paste arrives whole. Taken as one event so newlines in
      // it are content, not a stream of submits.
      if (input.startsWith(PASTE_START, i + 1)) {
        const from = i + 1 + PASTE_START.length
        const closer = input.indexOf(String.fromCharCode(27) + PASTE_END, from)
        const end = closer === -1 ? input.length : closer
        keys.push({ type: "paste", value: input.slice(from, end) })
        i = closer === -1 ? input.length : closer + 1 + PASTE_END.length
        continue
      }

      const next = input[i + 1]
      if (next !== "[" && next !== "O") {
        keys.push({ type: "escape" })
        i += 1
        continue
      }

      // CSI: ESC [ ... final-byte
      let j = i + 2
      let params = ""
      while (j < input.length && !/[A-Za-z~]/.test(input[j]!)) {
        params += input[j]
        j++
      }
      const final = input[j]

      // SGR mouse: ESC [ < button ; col ; row M|m. 64 and 65 are the wheel.
      // Without this the terminal sends the wheel as arrow keys and the
      // composer reads them as prompt history, so scrolling walked back
      // through what you had already typed.
      if (params.startsWith("<") && (final === "M" || final === "m")) {
        const button = Number(params.slice(1).split(";")[0])
        if (button === 64) keys.push({ type: "wheelup" })
        if (button === 65) keys.push({ type: "wheeldown" })
        const [, col, row] = params.slice(1).split(";").map(Number)
        if (button === 0 && final === "m" && col! > 0 && row! > 0) keys.push({ type: "click", col: col!, row: row! })
        i = j + 1
        continue
      }

      if (final === "~") {
        const type = TILDE[params.split(";")[0] ?? ""]
        if (type) keys.push({ type } as Key)
      } else if (final && CSI[final]) {
        // CSI 1;Nx carries a modifier: N is 1 plus a bitmask where 1 is shift
        // and 4 is control. So 2 is shift, 5 is control, 6 is both. Arrows
        // with modifiers are how the composer selects and moves by word.
        const modifier = Number(params.split(";")[1] ?? "1")
        const mask = Number.isFinite(modifier) ? modifier - 1 : 0
        const shift = (mask & 1) === 1
        const ctrl = (mask & 4) === 4

        const type = CSI[final]!
        if (shift && !ctrl && type === "up") keys.push({ type: "shiftup" })
        else if (shift && !ctrl && type === "down") keys.push({ type: "shiftdown" })
        else if (shift || ctrl) keys.push({ type, shift, ctrl } as Key)
        else keys.push({ type } as Key)
      }
      i = (final ? j + 1 : j)
      continue
    }

    if (code === 13 || code === 10) { keys.push({ type: "enter" }); i++; continue }
    if (code === 127 || code === 8) { keys.push({ type: "backspace" }); i++; continue }

    // Control characters, reported by the letter they are typed with.
    if (code < 32) {
      keys.push({ type: "ctrl", value: String.fromCharCode(code + 96) })
      i++
      continue
    }

    keys.push({ type: "char", value: char })
    i++
  }

  return keys
}
