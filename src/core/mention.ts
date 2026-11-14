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

export const imageTypeOf = (name: string) => {
  const dot = name.lastIndexOf(".")
  return dot < 0 ? undefined : IMAGE_TYPES[name.slice(dot).toLowerCase()]
}

/** Width and height from the file's own header (PNG, GIF, JPEG); undefined when it cannot be told. */
export function imageSize(bytes: Uint8Array): { width: number; height: number } | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (bytes.length > 24 && bytes[0] === 0x89 && bytes[1] === 0x50) return { width: view.getUint32(16), height: view.getUint32(20) }
  if (bytes.length > 10 && bytes[0] === 0x47 && bytes[1] === 0x49) return { width: view.getUint16(6, true), height: view.getUint16(8, true) }
  if (bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    for (let at = 2; at + 9 < bytes.length;) {
      if (bytes[at] !== 0xff) return undefined
      const marker = bytes[at + 1]!
      // Start-of-frame markers carry the size; C4, C8 and CC are tables, not frames.
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { width: view.getUint16(at + 7), height: view.getUint16(at + 5) }
      at += 2 + view.getUint16(at + 2)
    }
  }
  return undefined
}

export type ImageFile = { name: string; type: string; bytes: number; size?: { width: number; height: number }; image?: AttachedImage }

/** Reads a picture from disk. Over the size limit it is described but not loaded (`image` is absent). */
export async function readImageFile(absolute: string, name = path.basename(absolute)): Promise<ImageFile | undefined> {
  const type = imageTypeOf(absolute)
  if (!type) return undefined
  const stat = await fs.stat(absolute)
  if (!stat.isFile()) return undefined
  if (stat.size > MAX_IMAGE_BYTES) return { name, type, bytes: stat.size }
  const bytes = await fs.readFile(absolute)
  return { name, type, bytes: stat.size, size: imageSize(bytes), image: { name, dataUrl: `data:${type};base64,` + bytes.toString("base64") } }
}


/**
 * Picture paths written out in a message without an @: a full path (a drive letter, / or ~/), or any path in quotes.
 * These are what a dropped or copied screenshot looks like, and they are usually outside the project, where an
 * @mention cannot reach. A bare relative path stays text: "rename assets/logo.png" is not a request to look at it.
 */
export function typedImagePaths(text: string): string[] {
  const found: string[] = []
  const quoted = /"([^"\n]+\.(?:png|jpe?g|gif|webp))"|'([^'\n]+\.(?:png|jpe?g|gif|webp))'/gi
  const full = /(?:^|[\s(\[])((?:[A-Za-z]:[\\/]|~[\\/]|\/)[^"'<>|?*\n]*?\.(?:png|jpe?g|gif|webp))(?=$|[\s"',;:)\]!?]|\.(?:\s|$))/gi
  let match: RegExpExecArray | null
  while ((match = quoted.exec(text)) !== null) found.push(match[1] ?? match[2]!)
  while ((match = full.exec(text)) !== null) found.push(match[1]!)
  return [...new Set(found)]
}

const absoluteOf = (token: string, root: string) =>
  path.resolve(root, /^~[\\/]/.test(token) ? path.join(process.env.USERPROFILE || process.env.HOME || "", token.slice(2)) : token)

/**
 * Files dropped on the terminal that are all pictures: they are attached as pictures, wherever on disk they are.
 * Returns undefined when the paste is anything else, so it goes on to be a mention or plain text.
 */
export async function droppedImages(text: string, root: string): Promise<AttachedImage[] | undefined> {
  const tokens: string[] = []
  const words = /"([^"]+)"|(\S+)/g
  let match: RegExpExecArray | null
  while ((match = words.exec(text.trim())) !== null) tokens.push(match[1] ?? match[2]!)
  // An unquoted path with spaces in it arrives as several words; try the whole paste as one path too.
  const candidates = tokens.length > 1 && !text.includes('"') && imageTypeOf(text.trim()) ? [[text.trim()], tokens] : [tokens]
  for (const list of candidates) {
    if (!list.length || list.length > MAX_FILES || !list.every((token) => imageTypeOf(token) && /[\\/]/.test(token))) continue
    try {
      const files = await Promise.all(list.map((token) => readImageFile(absoluteOf(token, root))))
      if (files.every((file) => file?.image)) return files.map((file) => file!.image!)
    } catch {}
  }
  return undefined
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

  // Pictures named by a full or quoted path, without an @ - a dropped screenshot, most often.
  for (const candidate of typedImagePaths(text)) {
    if (images.length >= MAX_FILES) break
    try {
      const file = await readImageFile(absoluteOf(candidate, root))
      if (!file) continue
      if (!file.image) { blocks.push(`--- ${file.name} ---` + NEWLINE + `(not attached: ${Math.round(file.bytes / 1024)} KB is over the limit)`); continue }
      if (images.some((image) => image.dataUrl === file.image!.dataUrl)) continue
      images.push(file.image)
      files.push(file.name)
    } catch {
      // Not a file that exists: it stays the text it was.
    }
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
