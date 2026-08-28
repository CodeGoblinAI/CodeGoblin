import fs from "node:fs/promises"
import path from "node:path"
import { resolveInside, SKIP_DIRS } from "./tools"

/**
 * Finding code.
 *
 * Without these the model guesses paths and reads whole directories to
 * orient itself, which wastes a turn and a lot of context. Both walk the
 * tree themselves rather than shelling out to grep or find, so behaviour
 * does not depend on what happens to be installed.
 */

const MAX_MATCHES = 100
const MAX_FILE_BYTES = 2_000_000

/** Glob subset that covers real use: * within a segment, ** across segments, ?. */
/** Regex-escape without a backslash-laden regex literal. */
const BACKSLASH = String.fromCharCode(92)
const SPECIAL = new Set([".", "*", "+", "?", "^", "$", "{", "}", "(", ")", "|", "[", "]", BACKSLASH])
const escapeRegExp = (text: string) =>
  [...text].map((c) => (SPECIAL.has(c) ? BACKSLASH + c : c)).join("")

export function globToRegExp(pattern: string): RegExp {
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
    out += escapeRegExp(char)
    i++
  }
  return new RegExp("^" + out + "$", "i")
}

async function* walk(root: string, dir: string): AsyncGenerator<string> {
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) yield* walk(root, full)
    else yield path.relative(root, full).split(path.sep).join("/")
  }
}

export async function globFiles(root: string, pattern: string, limit = 200): Promise<string[]> {
  const matcher = globToRegExp(pattern)
  const found: { file: string; mtime: number }[] = []

  for await (const relative of walk(root, root)) {
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
): Promise<{ matches: string[]; truncated: boolean }> {
  let pattern: RegExp
  try {
    pattern = new RegExp(query, "i")
  } catch {
    // A bad regex should search literally rather than fail the turn.
    pattern = new RegExp(escapeRegExp(query), "i")
  }

  const filter = include ? globToRegExp(include) : undefined
  const matches: string[] = []

  for await (const relative of walk(root, root)) {
    if (filter && !filter.test(relative)) continue

    const absolute = path.join(root, relative)
    const stat = await fs.stat(absolute).catch(() => undefined)
    if (!stat || stat.size > MAX_FILE_BYTES) continue

    let content: string
    try {
      content = await fs.readFile(absolute, "utf8")
    } catch {
      continue
    }
    // Skip binaries rather than filling the context with noise.
    if (content.includes("\u0000")) continue

    const lines = content.split(String.fromCharCode(10))
    for (let index = 0; index < lines.length; index++) {
      if (!pattern.test(lines[index]!)) continue
      matches.push(`${relative}:${index + 1}: ${lines[index]!.trim().slice(0, 200)}`)
      if (matches.length >= MAX_MATCHES) return { matches, truncated: true }
    }
  }

  return { matches, truncated: false }
}

/** Kept here so the search tools share the sandbox check with the file tools. */
export function assertSearchable(root: string, target?: string) {
  if (target) resolveInside(root, target)
}
