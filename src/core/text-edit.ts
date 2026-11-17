/**
 * Finding and replacing a piece of a file the way a model describes it, not only the way the file spells it.
 *
 * A model writes line breaks as a plain newline. A file on Windows very often ends its lines with a carriage
 * return and a newline, and then no piece of it longer than one line matches exactly: every multi-line edit
 * of such a file failed with "old_string not found", and the model fell back to rewriting the whole file or
 * gave up. Trailing spaces fail the same way and are just as invisible.
 *
 * So: exactly first. Then with the file's own line endings. Then line by line, ignoring what is at the end
 * of each line. Never more loosely than that - indentation is meaning in some languages - but when the text
 * is there with different indentation, the error says so instead of "not found".
 *
 * Whatever is written back keeps the file's line endings, so one edit never turns a file into a mixture.
 */
const LF = String.fromCharCode(10), CR = String.fromCharCode(13)
const CRLF = CR + LF

/** The line ending a file uses: the one most of its lines have. A file with no line breaks takes LF. */
export function lineEndingOf(text: string): string {
  const crlf = text.split(CRLF).length - 1
  const lf = text.split(LF).length - 1 - crlf
  return crlf > lf ? CRLF : LF
}

/** Text with every line ending made `ending`, whatever it had. */
export function withLineEnding(text: string, ending: string): string {
  return text.split(CRLF).join(LF).split(LF).join(ending)
}

const count = (text: string, piece: string) => (piece ? text.split(piece).length - 1 : 0)
const squeezed = (text: string) => text.split(/\s+/).filter(Boolean).join(" ")

export type Replaced = { text: string; note?: string } | { error: string }

export function replaceOnce(before: string, oldText: string, newText: string, file: string): Replaced {
  if (!oldText) return { error: "error: old_string is empty" }
  const ending = lineEndingOf(before)

  const exact = count(before, oldText)
  // In a file with Windows line endings the new lines get them too, however the model wrote them.
  if (exact === 1) return { text: before.replace(oldText, () => (ending === CRLF ? withLineEnding(newText, CRLF) : newText)) }
  if (exact > 1) return { error: `error: old_string appears ${exact} times in ${file}; include more context to make it unique` }

  // The same text with the file's line endings.
  const spelled = withLineEnding(oldText, ending)
  const asFile = count(before, spelled)
  if (asFile === 1) return { text: before.replace(spelled, () => withLineEnding(newText, ending)) }
  if (asFile > 1) return { error: `error: old_string appears ${asFile} times in ${file}; include more context to make it unique` }

  // Line by line, ignoring what ends each line.
  const lines = before.split(LF)
  const wanted = withLineEnding(oldText, LF).split(LF).map((line) => line.trimEnd())
  if (wanted.length && wanted.at(-1) === "" && wanted.length > 1) wanted.pop()
  const found: number[] = []
  for (let at = 0; at + wanted.length <= lines.length; at++) {
    if (wanted.every((line, offset) => lines[at + offset]!.trimEnd() === line)) found.push(at)
  }
  if (found.length === 1) {
    const at = found[0]!
    const keepsCr = ending === CRLF
    const fresh = withLineEnding(newText, LF).split(LF)
    if (withLineEnding(oldText, LF).endsWith(LF) && fresh.at(-1) === "") fresh.pop()
    const last = at + wanted.length === lines.length
    const put = fresh.map((line, index) => (keepsCr && !(last && index === fresh.length - 1) ? line + CR : line))
    return { text: [...lines.slice(0, at), ...put, ...lines.slice(at + wanted.length)].join(LF), note: "(matched ignoring spaces at the ends of lines)" }
  }
  if (found.length > 1) return { error: `error: old_string appears ${found.length} times in ${file}; include more context to make it unique` }

  // There, but spaced differently: say so, because "not found" sends a model looking in the wrong place.
  if (squeezed(oldText) && squeezed(before).includes(squeezed(oldText))) {
    const tabs = /^\t+/m.test(before)
    return { error: `error: old_string is in ${file} but not with this spacing${tabs ? " - the file indents with tabs" : ""}. Copy the lines exactly as read_file shows them.` }
  }
  return { error: "error: old_string not found in " + file }
}
