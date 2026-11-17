import fs from "node:fs/promises"
import path from "node:path"
import { resolveInside, SKIP_DIRS } from "./tools"
import { isSecretPath } from "./secret-files"
import { decodeText } from "./text-edit"

/**
 * Finding code.
 *
 * Without these the model guesses paths and reads whole directories to
 * orient itself, which wastes a turn and a lot of context. Both walk the
 * tree themselves rather than shelling out to grep or find, so behaviour
 * does not depend on what happens to be installed.
 */

const MAX_MATCHES = 100
/**
 * Files past this are not searched, and the result names them. It was 2 MB and
 * skipped silently: a real model grepped a 5 MB log for a line on every row of
 * it, was told "no matches", and spent six turns working around the tool.
 */
const MAX_FILE_BYTES = 50_000_000

/** Glob subset that covers real use: * within a segment, ** across segments, ?. */
/** Regex-escape without a backslash-laden regex literal. */
const BACKSLASH = String.fromCharCode(92)
const SPECIAL = new Set([".", "*", "+", "?", "^", "$", "{", "}", "(", ")", "|", "[", "]", BACKSLASH])
const escapeRegExp = (text: string) =>
  [...text].map((c) => (SPECIAL.has(c) ? BACKSLASH + c : c)).join("")

export function globToRegExp(pattern: string): RegExp {
  return new RegExp("^" + globBody(pattern) + "$", "i")
}

/**
 * The conversion itself, separate so brace alternatives can reuse it.
 *
 * Alternation is here because models reach for it constantly:
 * `src/{tui,web,cli}/*.ts` is the obvious way to ask about three directories
 * at once. Without it the braces were escaped into the pattern as literal
 * characters, so the glob matched nothing - and said so in exactly the words
 * it uses for a pattern whose files genuinely are not there. Nothing could
 * tell those two apart, and the first model to hit it concluded the files did
 * not exist, answered on that, and had to retract the answer a turn later.
 */
function globBody(pattern: string): string {
  let out = ""
  let i = 0
  while (i < pattern.length) {
    const char = pattern[i]!
    if (char === "*") {
      if (pattern[i + 1] === "*") {
        out += ".*"
        i += 2
        if (pattern[i] === "/") i++
        continue
      }
      out += "[^/]*"
      i++
      continue
    }
    if (char === "?") { out += "[^/]"; i++; continue }
    if (char === "{") {
      const end = closingBrace(pattern, i)
      if (end !== -1) {
        out += "(?:" + splitAlternatives(pattern.slice(i + 1, end)).map(globBody).join("|") + ")"
        i = end + 1
        continue
      }
      // An unmatched brace is a literal brace rather than a syntax error.
      // Refusing the whole pattern would be worse than matching the file that
      // happens to have one in its name.
    }
    out += escapeRegExp(char)
    i++
  }
  return out
}

/** Where the `}` closing the `{` at `from` is, or -1 when it is never closed. */
function closingBrace(pattern: string, from: number): number {
  let depth = 0
  for (let i = from; i < pattern.length; i++) {
    if (pattern[i] === "{") depth++
    else if (pattern[i] === "}" && --depth === 0) return i
  }
  return -1
}

/** Split on the commas belonging to this brace, not to one nested inside it. */
function splitAlternatives(body: string): string[] {
  const parts: string[] = []
  let depth = 0
  let start = 0
  for (let i = 0; i < body.length; i++) {
    const char = body[i]
    if (char === "{") depth++
    else if (char === "}") depth--
    else if (char === "," && depth === 0) {
      parts.push(body.slice(start, i))
      start = i + 1
    }
  }
  parts.push(body.slice(start))
  return parts
}

/**
 * Files one search looks at before giving up and saying so. A real model,
 * started in the home folder, grepped all of it - AppData, OneDrive, every
 * editor extension - and the turn could not be stopped while it did.
 */
export const MAX_FILES_SCANNED = 50_000

/**
 * How long one search may run before it reports what it has and says it stopped. The file cap alone did not
 * bound it: from a home folder the first 50,000 files are caches, extensions and media, and reading them took
 * over a minute and a half - a turn that looked stuck on a simple question. Twenty seconds is far more than a
 * search inside a project needs (under one).
 */
export const SEARCH_BUDGET_MS = 20_000
/** Above this size a file's first bytes are checked before the whole of it is read, so a large binary costs nothing. */
const SNIFF_ABOVE_BYTES = 256_000

/** Why a walk ended early, if it did. `seen` is how many files it had looked at. */
export type WalkEnd = { stopped: boolean; capped: boolean; timedOut?: boolean; seen?: number; budgetMs?: number }

async function* walk(root: string, dir: string, signal?: AbortSignal): AsyncGenerator<string> {
  if (signal?.aborted) return
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (signal?.aborted) return
    if (SKIP_DIRS.has(entry.name)) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) yield* walk(root, full, signal)
    else yield path.relative(root, full).split(path.sep).join("/")
  }
}

/** The walk, counted: ends at the cap or on stop, and says which. */
async function* bounded(root: string, end: WalkEnd, signal?: AbortSignal, cap = MAX_FILES_SCANNED): AsyncGenerator<string> {
  let seen = 0
  const deadline = Date.now() + (end.budgetMs ?? SEARCH_BUDGET_MS)
  for await (const relative of walk(root, root, signal)) {
    if (++seen > cap) { end.capped = true; return }
    if (Date.now() > deadline) { end.timedOut = true; end.seen = seen - 1; return }
    yield relative
  }
  if (signal?.aborted) end.stopped = true
}

/** The sentence a search adds when it did not look everywhere. */
export function walkNote(end: WalkEnd, cap = MAX_FILES_SCANNED): string {
  if (end.stopped) return "stopped by the user part way through"
  if (end.timedOut) return `stopped after ${Math.round((end.budgetMs ?? SEARCH_BUDGET_MS) / 1000)}s, having looked at the first ${(end.seen ?? 0).toLocaleString("en-US")} files: this folder is too large to search whole - give a folder (path) or a file pattern to narrow it`
  if (end.capped) return `searched the first ${cap.toLocaleString("en-US")} files and stopped - narrow it with a folder or pattern`
  return ""
}

/**
 * A pattern written as an absolute path, made relative to the root it is
 * matched against. Paths are matched relative, so `C:/Users/x/proj/src/**`
 * matched nothing - after walking every file to find that out. A real run lost
 * its last minutes, and its stop button, to exactly that.
 */
export function relativePattern(root: string, pattern: string): string {
  const slashed = pattern.split(BACKSLASH).join("/")
  if (!path.isAbsolute(slashed)) return slashed
  const rootSlashed = path.resolve(root).split(BACKSLASH).join("/").replace(/\/$/, "")
  const lower = slashed.toLowerCase()
  if (lower === rootSlashed.toLowerCase()) return "**"
  if (lower.startsWith(rootSlashed.toLowerCase() + "/")) return slashed.slice(rootSlashed.length + 1)
  throw new Error(`the pattern ${pattern} is outside the working directory (${root}); patterns are relative to it`)
}

export async function globFiles(root: string, pattern: string, limit = 200, signal?: AbortSignal, end: WalkEnd = { stopped: false, capped: false }): Promise<string[]> {
  const matcher = globToRegExp(relativePattern(root, pattern))
  const found: { file: string; mtime: number }[] = []

  for await (const relative of bounded(root, end, signal)) {
    if (!matcher.test(relative)) continue
    const stat = await fs.stat(path.join(root, relative)).catch(() => undefined)
    found.push({ file: relative, mtime: stat?.mtimeMs ?? 0 })
    if (found.length >= limit * 4) break
  }

  // Newest first: what someone is working on is usually what they mean.
  return found.sort((a, b) => b.mtime - a.mtime).slice(0, limit).map((entry) => entry.file)
}

export async function grepFiles(
  root: string,
  query: string,
  include?: string,
  signal?: AbortSignal,
  budgetMs?: number,
): Promise<{ matches: string[]; truncated: boolean; skipped: string[]; secret: string[]; total: number; end: WalkEnd }> {
  const end: WalkEnd = { stopped: false, capped: false, budgetMs }
  let pattern: RegExp
  try {
    pattern = new RegExp(query, "i")
  } catch {
    // A bad regex should search literally rather than fail the turn.
    pattern = new RegExp(escapeRegExp(query), "i")
  }

  const filter = include ? globToRegExp(relativePattern(root, include)) : undefined
  const matches: string[] = []
  const skipped: string[] = []
  // Files that hold secrets are never searched: a match prints the line, and
  // the line is the key. read_file asks about one when the task needs it.
  const secret: string[] = []
  let total = 0

  for await (const relative of bounded(root, end, signal)) {
    if (filter && !filter.test(relative)) continue
    if (isSecretPath(relative)) { secret.push(relative); continue }

    let absolute: string
    try { absolute = resolveInside(root, relative) } catch { continue }
    const stat = await fs.stat(absolute).catch(() => undefined)
    if (!stat || !stat.isFile()) continue
    if (stat.size > MAX_FILE_BYTES) {
      skipped.push(relative)
      continue
    }

    if (stat.size > SNIFF_ABOVE_BYTES && await looksBinary(absolute)) continue

    // Skip binaries rather than filling the context with noise - but UTF-16 with its byte order mark is text
    // (a Windows PowerShell log, a .reg export) and is searched as text.
    let content: string
    try {
      const decoded = decodeText(await fs.readFile(absolute))
      if (!decoded) continue
      content = decoded.text
    } catch {
      continue
    }

    const lines = content.split(String.fromCharCode(10))
    for (let index = 0; index < lines.length; index++) {
      if (!pattern.test(lines[index]!)) continue
      total++
      // Past the cap, lines are counted rather than kept. Stopping at the cap
      // left "how many lines match?" unanswerable: a real model spent four
      // turns inferring 60,000 from which line did not match.
      if (matches.length < MAX_MATCHES) matches.push(`${relative}:${index + 1}: ${lines[index]!.trim().slice(0, 200)}`)
    }
  }

  return { matches, truncated: total > matches.length, skipped, secret, total, end }
}

/** Whether a file's first bytes hold a NUL - the cheap way to tell a large binary without reading it. */
async function looksBinary(absolute: string): Promise<boolean> {
  let handle
  try {
    handle = await fs.open(absolute, "r")
    const { bytesRead, buffer } = await handle.read(Buffer.alloc(4096), 0, 4096, 0)
    return decodeText(buffer.subarray(0, bytesRead)) === undefined
  } catch {
    return false
  } finally {
    await handle?.close().catch(() => {})
  }
}

/** Kept here so the search tools share the sandbox check with the file tools. */
export function assertSearchable(root: string, target?: string) {
  if (target) resolveInside(root, target)
}
