/**
 * What actually changed.
 *
 * "+1 -1" is not review, and review is most of what a coding tool is for.
 * This turns a before and an after into hunks somebody can read, with no
 * dependency and no shelling out to git - the files being compared are
 * usually not committed, which is the whole reason the agent's edits need
 * looking at in the first place.
 */

export type DiffLine = {
  kind: "context" | "add" | "remove"
  text: string
  /** Line number in the before text, when the line exists there. */
  before?: number
  /** Line number in the after text, when the line exists there. */
  after?: number
}

export type Hunk = {
  beforeStart: number
  beforeCount: number
  afterStart: number
  afterCount: number
  lines: DiffLine[]
}

export type FileDiff = {
  path: string
  status: "added" | "removed" | "modified" | "unchanged"
  added: number
  removed: number
  hunks: Hunk[]
  /**
   * Set when the file was too large to diff line by line, so a reader is
   * told the counts are a summary rather than quietly given a wrong one.
   */
  truncated?: boolean
}

const NEWLINE = String.fromCharCode(10)

/**
 * Beyond this many differing lines on either side we stop.
 *
 * The comparison is quadratic in the differing region, so a pathological
 * pair - a minified bundle, a lock file rewritten wholesale - would sit
 * there allocating for a very long time. Saying "too large" is a worse
 * answer than a diff and a much better one than a frozen terminal.
 */
const MAX_REGION = 1500

function split(text: string): string[] {
  if (text === "") return []
  // A trailing newline ends the last line rather than starting an empty one.
  const lines = text.split(NEWLINE)
  if (lines[lines.length - 1] === "") lines.pop()
  return lines
}

/**
 * The longest common subsequence, as a walk.
 *
 * Prefix and suffix are trimmed first, which is what makes this affordable:
 * an edit to one line of a thousand-line file leaves a region of one, and
 * the table is built over the region rather than the file.
 */
function walk(before: string[], after: string[]): DiffLine[] {
  const out: DiffLine[] = []

  let head = 0
  while (head < before.length && head < after.length && before[head] === after[head]) head++

  let tail = 0
  while (
    tail < before.length - head &&
    tail < after.length - head &&
    before[before.length - 1 - tail] === after[after.length - 1 - tail]
  ) {
    tail++
  }

  const midBefore = before.slice(head, before.length - tail)
  const midAfter = after.slice(head, after.length - tail)

  for (let i = 0; i < head; i++) {
    out.push({ kind: "context", text: before[i], before: i + 1, after: i + 1 })
  }

  if (midBefore.length > MAX_REGION || midAfter.length > MAX_REGION) {
    for (const [i, text] of midBefore.entries()) out.push({ kind: "remove", text, before: head + i + 1 })
    for (const [i, text] of midAfter.entries()) out.push({ kind: "add", text, after: head + i + 1 })
  } else {
    // table[i][j] is the LCS length of midBefore[i..] and midAfter[j..].
    const rows = midBefore.length
    const cols = midAfter.length
    const table: number[][] = Array.from({ length: rows + 1 }, () => new Array(cols + 1).fill(0))
    for (let i = rows - 1; i >= 0; i--) {
      for (let j = cols - 1; j >= 0; j--) {
        table[i][j] =
          midBefore[i] === midAfter[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1])
      }
    }

    let i = 0
    let j = 0
    while (i < rows && j < cols) {
      if (midBefore[i] === midAfter[j]) {
        out.push({ kind: "context", text: midBefore[i], before: head + i + 1, after: head + j + 1 })
        i++
        j++
      } else if (table[i + 1][j] >= table[i][j + 1]) {
        out.push({ kind: "remove", text: midBefore[i], before: head + i + 1 })
        i++
      } else {
        out.push({ kind: "add", text: midAfter[j], after: head + j + 1 })
        j++
      }
    }
    while (i < rows) {
      out.push({ kind: "remove", text: midBefore[i], before: head + i + 1 })
      i++
    }
    while (j < cols) {
      out.push({ kind: "add", text: midAfter[j], after: head + j + 1 })
      j++
    }
  }

  for (let k = 0; k < tail; k++) {
    const beforeLine = before.length - tail + k
    const afterLine = after.length - tail + k
    out.push({ kind: "context", text: before[beforeLine], before: beforeLine + 1, after: afterLine + 1 })
  }

  return out
}

/**
 * Group the walk into hunks with context either side.
 *
 * A file's unchanged middle is not worth reading, and showing it buries the
 * three lines that are.
 */
function hunksFrom(lines: DiffLine[], context: number): Hunk[] {
  const interesting = lines
    .map((line, index) => (line.kind === "context" ? -1 : index))
    .filter((index) => index >= 0)
  if (!interesting.length) return []

  const ranges: { from: number; to: number }[] = []
  for (const index of interesting) {
    const from = Math.max(0, index - context)
    const to = Math.min(lines.length - 1, index + context)
    const last = ranges[ranges.length - 1]
    // Touching ranges become one hunk rather than two with a one-line gap,
    // which would read as a break where nothing was skipped.
    if (last && from <= last.to + 1) last.to = Math.max(last.to, to)
    else ranges.push({ from, to })
  }

  return ranges.map((range) => {
    const slice = lines.slice(range.from, range.to + 1)
    const firstBefore = slice.find((line) => line.before !== undefined)?.before
    const firstAfter = slice.find((line) => line.after !== undefined)?.after
    return {
      beforeStart: firstBefore ?? 0,
      beforeCount: slice.filter((line) => line.kind !== "add").length,
      afterStart: firstAfter ?? 0,
      afterCount: slice.filter((line) => line.kind !== "remove").length,
      lines: slice,
    }
  })
}

/**
 * Compare one file.
 *
 * `null` means the file was not there: null before is a file the turn
 * created, null after is one it deleted. Both are ordinary outcomes of an
 * agent editing a tree and neither should read as an error.
 */
export function diffFile(
  path: string,
  before: string | null,
  after: string | null,
  context = 3,
): FileDiff {
  const beforeLines = split(before ?? "")
  const afterLines = split(after ?? "")

  const status: FileDiff["status"] =
    before === null && after === null
      ? "unchanged"
      : before === null
        ? "added"
        : after === null
          ? "removed"
          : before === after
            ? "unchanged"
            : "modified"

  if (status === "unchanged") {
    return { path, status, added: 0, removed: 0, hunks: [] }
  }

  const walked = walk(beforeLines, afterLines)
  const added = walked.filter((line) => line.kind === "add").length
  const removed = walked.filter((line) => line.kind === "remove").length
  const truncated = beforeLines.length > MAX_REGION || afterLines.length > MAX_REGION

  return {
    path,
    status,
    added,
    removed,
    hunks: hunksFrom(walked, context),
    ...(truncated ? { truncated: true } : {}),
  }
}

/** "+12 -3", or "+12" when nothing was taken away. */
export function countsOf(diff: FileDiff): string {
  const parts: string[] = []
  if (diff.added) parts.push("+" + diff.added)
  if (diff.removed) parts.push("-" + diff.removed)
  return parts.join(" ") || "no change"
}

/** A / D / M, the letters every review tool uses. */
export function statusLetter(diff: FileDiff): string {
  if (diff.status === "added") return "A"
  if (diff.status === "removed") return "D"
  if (diff.status === "modified") return "M"
  return " "
}

/** The whole thing as a patch, for /export and for anyone who wants to pipe it. */
export function toUnified(diff: FileDiff): string {
  const lines: string[] = [
    "--- " + (diff.status === "added" ? "/dev/null" : "a/" + diff.path),
    "+++ " + (diff.status === "removed" ? "/dev/null" : "b/" + diff.path),
  ]
  for (const hunk of diff.hunks) {
    lines.push(
      "@@ -" + hunk.beforeStart + "," + hunk.beforeCount +
        " +" + hunk.afterStart + "," + hunk.afterCount + " @@",
    )
    for (const line of hunk.lines) {
      lines.push((line.kind === "add" ? "+" : line.kind === "remove" ? "-" : " ") + line.text)
    }
  }
  return lines.join(NEWLINE)
}

/** Files with the most movement first: the big rewrite is what you look at. */
export function byImpact(diffs: FileDiff[]): FileDiff[] {
  return [...diffs].sort((a, b) => b.added + b.removed - (a.added + a.removed) || a.path.localeCompare(b.path))
}
