import fs from "node:fs/promises"
import { resolveInside, clip } from "./tools"

/**
 * @-mentions.
 *
 * The composer has advertised "@ for context" since the first version, which
 * was a promise the app did not keep. It does now: an @path that resolves to a
 * real file is read and attached to the message, so the model is handed the
 * file instead of having to guess that it should go and read it.
 *
 * A mention that resolves to nothing stays literal. @ is ordinary punctuation
 * in email addresses, npm scopes and decorators, and mangling those would be
 * worse than doing nothing at all.
 */

const MAX_FILES = 10
const NEWLINE = String.fromCharCode(10)

/** Characters that end a sentence rather than a filename. */
const TRAILING = new Set([",", ";", ":", ")", "]", "}", "!", "?", "'", '"', "."])
const SPACE = new Set([" ", "\t", "\n", "\r"])

const isSpace = (char: string | undefined) => char === undefined || SPACE.has(char)

export type Mention = { start: number; end: number; query: string }

/**
 * The mention the caret is sitting in, if any.
 *
 * The @ has to open a word: mid-word it is an email address, and completing
 * over the back half of someone's address would be an odd thing to do.
 */
export function findMention(text: string, cursor: number): Mention | undefined {
  const caret = Math.max(0, Math.min(cursor, text.length))
  let start = -1
  for (let index = caret - 1; index >= 0; index--) {
    const char = text[index]!
    if (isSpace(char)) return undefined
    if (char === "@") { start = index; break }
  }
  if (start < 0) return undefined
  if (start > 0 && !isSpace(text[start - 1])) return undefined

  // Completion replaces the whole token, so finishing a path from the middle
  // does not leave the old tail stranded behind the caret.
  let end = caret
  while (end < text.length && !isSpace(text[end])) end++

  return { start, end, query: text.slice(start + 1, caret) }
}

/** Every @token in a message, trailing punctuation trimmed, in order, deduped. */
export function mentionPaths(text: string): string[] {
  const found: string[] = []
  for (let index = 0; index < text.length; index++) {
    if (text[index] !== "@") continue
    if (index > 0 && !isSpace(text[index - 1])) continue
    let end = index + 1
    while (end < text.length && !isSpace(text[end])) end++
    let token = text.slice(index + 1, end)
    while (token.length && TRAILING.has(token[token.length - 1]!)) token = token.slice(0, -1)
    if (token) found.push(token)
    index = end
  }
  return [...new Set(found)]
}

/**
 * Read what the message mentions.
 *
 * Returns the text the model should see. The caller keeps the text the user
 * typed for display, so the thread shows "@src/core/tools.ts" rather than the
 * file spilled across the transcript.
 */
export async function expandMentions(
  text: string,
  root: string,
): Promise<{ content: string; files: string[] }> {
  const blocks: string[] = []
  const files: string[] = []

  for (const candidate of mentionPaths(text)) {
    if (files.length >= MAX_FILES) break
    let body: string
    try {
      const absolute = resolveInside(root, candidate)
      const stat = await fs.stat(absolute)
      if (!stat.isFile()) continue
      body = await fs.readFile(absolute, "utf8")
    } catch {
      // Missing, unreadable, or outside the working directory: leave it alone.
      continue
    }
    if (body.includes("\u0000")) continue
    files.push(candidate)
    blocks.push(`--- ${candidate} ---` + NEWLINE + clip(body))
  }

  if (!blocks.length) return { content: text, files: [] }
  const attached = "Attached files:" + NEWLINE + NEWLINE + blocks.join(NEWLINE + NEWLINE)
  return { content: text + NEWLINE + NEWLINE + attached, files }
}
