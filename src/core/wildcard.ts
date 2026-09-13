/**
 * A permission pattern matched against a command, the way the fork matches it.
 *
 * Ported rather than reinvented, so a rule written for the fork means the same
 * thing here. `*` is anything and `?` is one character. A trailing " *" also
 * covers the bare command, so "ls *" matches "ls". Backslashes count as forward
 * slashes. On Windows case is ignored - PowerShell ignores it, so a rule written
 * "Remove-Item" has to catch "remove-item".
 *
 * It is a pattern over the text, not a shell parser. "*del *" also matches
 * "--model x", because "model " contains "del ". That errs toward refusing,
 * which is the right direction for a deny rule to be wrong in - but it is still
 * wrong, and worth knowing when writing one.
 */

// Escaped without a backslash-laden regex literal, the way search.ts does it.
const BACKSLASH = String.fromCharCode(92)
const SPECIAL = new Set([".", "+", "^", "$", "{", "}", "(", ")", "|", "[", "]", BACKSLASH])

export function matchesPattern(text: string, pattern: string, platform: string = process.platform): boolean {
  const subject = text.split(BACKSLASH).join("/")
  let body = ""
  for (const char of pattern.split(BACKSLASH).join("/")) {
    if (char === "*") body += ".*"
    else if (char === "?") body += "."
    else body += SPECIAL.has(char) ? BACKSLASH + char : char
  }
  if (body.endsWith(" .*")) body = body.slice(0, -3) + "( .*)?"
  return new RegExp("^" + body + "$", platform === "win32" ? "si" : "s").test(subject)
}

/**
 * The value of the most specific pattern that matches, or nothing.
 *
 * Longest pattern wins, and a tie goes to the one that sorts last - the fork's
 * order - so a narrow rule can carve an exception out of a broad one.
 */
export function mostSpecific<T>(
  text: string,
  patterns: Record<string, T>,
  platform: string = process.platform,
): T | undefined {
  const ordered = Object.entries(patterns).sort(
    ([a], [b]) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0),
  )
  let found: T | undefined
  for (const [pattern, value] of ordered) {
    if (matchesPattern(text, pattern, platform)) found = value
  }
  return found
}
