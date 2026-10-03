import fs from "node:fs/promises"
import { statSync } from "node:fs"
import path from "node:path"
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

/**
 * Pictures a vision model can be shown.
 *
 * Everything here used to be read as UTF-8 and then thrown away for holding a
 * NUL byte, which is how @screenshot.png became silently nothing at all.
 */
const IMAGE_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
}

/**
 * How large an attached image may be, before encoding.
 *
 * Providers cap a request, base64 adds a third on top, and a phone photo can
 * be 8 MB - which would fail as a wall of provider JSON rather than as a
 * sentence about a file.
 */
const MAX_IMAGE_BYTES = 5_000_000

export type AttachedImage = { name: string; dataUrl: string }

const imageTypeOf = (name: string) => {
  const dot = name.lastIndexOf(".")
  return dot < 0 ? undefined : IMAGE_TYPES[name.slice(dot).toLowerCase()]
}

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
): Promise<{ content: string; files: string[]; images: AttachedImage[] }> {
  const blocks: string[] = []
  const files: string[] = []
  const images: AttachedImage[] = []

  for (const candidate of mentionPaths(text)) {
    if (files.length >= MAX_FILES) break

    let absolute: string
    try {
      absolute = resolveInside(root, candidate)
      const stat = await fs.stat(absolute)
      if (!stat.isFile()) continue

      // A picture is attached as a picture rather than read as text. The size
      // is checked before the read, since the point of a cap is not to load
      // the thing first and then decide.
      const type = imageTypeOf(candidate)
      if (type) {
        files.push(candidate)
        if (stat.size > MAX_IMAGE_BYTES) {
          blocks.push(
            `--- ${candidate} ---` + NEWLINE + `(not attached: ${Math.round(stat.size / 1024)} KB is over the limit)`,
          )
          continue
        }
        const bytes = await fs.readFile(absolute)
        images.push({ name: candidate, dataUrl: `data:${type};base64,` + bytes.toString("base64") })
        continue
      }
    } catch {
      // Missing, unreadable, or outside the working directory: leave it alone.
      continue
    }

    let body: string
    try {
      body = await fs.readFile(absolute, "utf8")
    } catch {
      continue
    }
    if (body.includes(String.fromCharCode(0))) continue
    files.push(candidate)
    blocks.push(`--- ${candidate} ---` + NEWLINE + clip(body))
  }

  if (!blocks.length) return { content: text, files, images }
  const attached = "Attached files:" + NEWLINE + NEWLINE + blocks.join(NEWLINE + NEWLINE)
  return { content: text + NEWLINE + NEWLINE + attached, files, images }
}

/**
 * Files dropped from Explorer arrive as a paste of quoted paths. Turn the
 * ones that resolve to real files into mentions, so dropping is attaching.
 *
 * Only a paste made of nothing but project file paths converts. One that
 * merely contains a path - a log, a snippet, a sentence - stays exactly as
 * pasted: converting its one path used to re-join the rest with single
 * spaces, flattening newlines and dropping quotes. A path outside the
 * project, not a file, or with a space in it (a mention cannot carry one)
 * leaves the paste alone too.
 */
export function droppedMentions(text: string, root: string): string | undefined {
  const tokens: string[] = []
  const words = /"([^"]+)"|(\S+)/g
  let match: RegExpExecArray | null
  while ((match = words.exec(text)) !== null) tokens.push(match[1] ?? match[2]!)
  if (!tokens.length) return undefined
  const mentions: string[] = []
  for (const token of tokens) {
    const mention = /[\\/]/.test(token) ? fileMention(token, root) : undefined
    if (!mention || /\s/.test(mention)) return undefined
    mentions.push(mention)
  }
  return mentions.join(" ") + " "
}

function fileMention(token: string, root: string): string | undefined {
  let absolute: string
  try {
    absolute = resolveInside(root, token)
    if (!statSync(absolute).isFile()) return undefined
  } catch {
    return undefined
  }
  return "@" + path.relative(root, absolute).split(path.sep).join("/")
}
