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
  | { type: "up" }
  | { type: "down" }
  | { type: "left" }
  | { type: "right" }
  | { type: "home" }
  | { type: "end" }
  | { type: "pageup" }
  | { type: "pagedown" }
  | { type: "wheelup" }
  | { type: "wheeldown" }
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

const PASTE_START = "[200~"
const PASTE_END = "[201~"

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
        i = j + 1
        continue
      }

      if (final === "~") {
        const type = TILDE[params.split(";")[0] ?? ""]
        if (type) keys.push({ type } as Key)
      } else if (final && CSI[final]) {
        // Modifier 2 is shift: CSI 1;2A and 1;2B scroll a line at a time,
        // since the wheel belongs to the terminal now.
        const shifted = params.endsWith(";2")
        if (shifted && final === "A") keys.push({ type: "shiftup" })
        else if (shifted && final === "B") keys.push({ type: "shiftdown" })
        else keys.push({ type: CSI[final]! } as Key)
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
