import fs from "node:fs"
import path from "node:path"
import { assertWritable, resolveInside } from "./tools"
import { decodeText, encodeText, lineEndingOf, withLineEnding, type TextEncoding } from "./text-edit"

/**
 * apply_patch: the multi-file patch format GPT and Codex models are trained
 * to write, as the fork and Codex CLI offer it.
 *
 *   *** Begin Patch
 *   *** Add File: path        (every line +)
 *   *** Update File: path     (optional *** Move to: path, then @@ hunks)
 *   *** Delete File: path
 *   *** End Patch
 *
 * The whole patch is worked out before anything is written: one hunk that
 * does not match, and no file is touched. Every path stays inside the
 * working directory. A deleted file is recorded for /undo like any write.
 */
export type PatchOp =
  | { kind: "add"; path: string; content: string }
  | { kind: "delete"; path: string }
  | { kind: "update"; path: string; moveTo?: string; hunks: { context?: string; lines: string[] }[] }

const NEWLINE = String.fromCharCode(10)

export function parsePatch(text: string): PatchOp[] {
  const lines = text.replace(/\r\n?/g, NEWLINE).split(NEWLINE)
  let at = lines.findIndex((line) => line.trim() === "*** Begin Patch")
  if (at < 0) throw new Error("a patch starts with *** Begin Patch")
  const ops: PatchOp[] = []
  at++
  while (at < lines.length) {
    const line = lines[at]!
    if (line.trim() === "*** End Patch") return ops
    const header = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(line)
    if (!header) {
      if (!line.trim()) { at++; continue }
      throw new Error(`expected a file header at line ${at + 1}, found: ${line.slice(0, 80)}`)
    }
    const [, verb, file] = header
    at++
    if (verb === "Delete") { ops.push({ kind: "delete", path: file!.trim() }); continue }
    if (verb === "Add") {
      const body: string[] = []
      while (at < lines.length && !lines[at]!.startsWith("*** ")) {
        const entry = lines[at]!
        if (!entry.startsWith("+")) throw new Error(`every line of an added file starts with + (line ${at + 1})`)
        body.push(entry.slice(1))
        at++
      }
      ops.push({ kind: "add", path: file!.trim(), content: body.join(NEWLINE) + NEWLINE })
      continue
    }
    let moveTo: string | undefined
    if (/^\*\*\* Move to: /.test(lines[at] ?? "")) { moveTo = lines[at]!.slice("*** Move to: ".length).trim(); at++ }
    const hunks: { context?: string; lines: string[] }[] = []
    while (at < lines.length && !/^\*\*\* (Add|Update|Delete) File: |^\*\*\* End Patch/.test(lines[at]!)) {
      const entry = lines[at]!
      if (entry.startsWith("@@")) { hunks.push({ context: entry.slice(2).trim() || undefined, lines: [] }); at++; continue }
      if (entry === "*** End of File") { at++; continue }
      if (!hunks.length) hunks.push({ lines: [] })
      if (!/^[ +-]/.test(entry) && entry !== "") throw new Error(`a hunk line starts with space, + or - (line ${at + 1})`)
      hunks.at(-1)!.lines.push(entry === "" ? " " : entry)
      at++
    }
    if (!hunks.some((hunk) => hunk.lines.some((each) => each[0] !== " ")) && !moveTo) throw new Error(`the update to ${file} changes nothing`)
    ops.push({ kind: "update", path: file!.trim(), ...(moveTo ? { moveTo } : {}), hunks })
  }
  throw new Error("a patch ends with *** End Patch")
}

/** Where a block of lines sits in a file, from `from` on: exactly, then ignoring trailing spaces. */
function find(haystack: string[], needle: string[], from: number): number {
  const fits = (at: number, same: (a: string, b: string) => boolean) => needle.every((line, offset) => same(haystack[at + offset] ?? "", line))
  for (let at = from; at + needle.length <= haystack.length; at++) if (fits(at, (a, b) => a === b)) return at
  for (let at = from; at + needle.length <= haystack.length; at++) if (fits(at, (a, b) => a.trimEnd() === b.trimEnd())) return at
  return -1
}

function applyHunks(file: string, source: string, hunks: { context?: string; lines: string[] }[]): string {
  // Worked on with plain newlines and written back with the file's own line endings. Lines used to be split
  // on the newline alone, so in a file that ends its lines the Windows way every changed line came back
  // without its carriage return and the file was left a mixture of the two.
  const eol = lineEndingOf(source)
  const original = withLineEnding(source, NEWLINE)
  const ending = original.endsWith(NEWLINE)
  const lines = (ending ? original.slice(0, -1) : original).split(NEWLINE)
  let cursor = 0
  for (const hunk of hunks) {
    if (hunk.context) {
      const anchor = find(lines, [hunk.context], cursor)
      if (anchor >= 0) cursor = anchor
    }
    const before = hunk.lines.filter((line) => line[0] !== "+").map((line) => line.slice(1))
    const after = hunk.lines.filter((line) => line[0] !== "-").map((line) => line.slice(1))
    if (!before.length) { lines.splice(cursor, 0, ...after); cursor += after.length; continue }
    const at = find(lines, before, cursor)
    if (at < 0) throw new Error(`a hunk in ${file} does not match the file: ${before.find((line) => line.trim())?.trim().slice(0, 60) ?? "(blank lines)"} - read the file and try again`)
    lines.splice(at, before.length, ...after)
    cursor = at + after.length
  }
  return withLineEnding(lines.join(NEWLINE) + (ending ? NEWLINE : ""), eol)
}

export type PatchPlan = { writes: { path: string; content: string | null; encoding?: TextEncoding }[]; summary: string[] }

/** Works the whole patch out against the tree without writing anything. */
export function planPatch(root: string, ops: PatchOp[]): PatchPlan {
  const state = new Map<string, string | null>()
  // How each file read was stored, so it is written back the same way (UTF-16 stays UTF-16; see text-edit.ts).
  const encodings = new Map<string, TextEncoding>()
  const read = (relative: string) => {
    if (state.has(relative)) return state.get(relative)!
    let bytes: Buffer
    try { bytes = fs.readFileSync(resolveInside(root, relative)) } catch { return null }
    const decoded = decodeText(bytes)
    if (!decoded) throw new Error(`${relative} is not a text file; a patch cannot change it`)
    encodings.set(relative, decoded.encoding)
    return decoded.text
  }
  const summary: string[] = []
  for (const op of ops) {
    const target = resolveInside(root, op.path)
    assertWritable(path.relative(root, target))
    if (op.kind === "add") {
      if (read(op.path) !== null) throw new Error(`${op.path} already exists - update it instead of adding it`)
      state.set(op.path, op.content)
      summary.push("added " + op.path)
    } else if (op.kind === "delete") {
      if (read(op.path) === null) throw new Error(`${op.path} does not exist`)
      state.set(op.path, null)
      summary.push("deleted " + op.path)
    } else {
      const original = read(op.path)
      if (original === null) throw new Error(`${op.path} does not exist - add it instead`)
      const updated = applyHunks(op.path, original, op.hunks)
      if (op.moveTo) {
        const moved = resolveInside(root, op.moveTo)
        assertWritable(path.relative(root, moved))
        if (read(op.moveTo) !== null) throw new Error(`${op.moveTo} already exists`)
        state.set(op.path, null)
        state.set(op.moveTo, updated)
        const kept = encodings.get(op.path)
        if (kept) encodings.set(op.moveTo, kept)
        summary.push(`moved ${op.path} to ${op.moveTo}`)
      } else {
        state.set(op.path, updated)
        summary.push("updated " + op.path)
      }
    }
  }
  return { writes: [...state.entries()].map(([file, content]) => ({ path: file, content, ...(encodings.get(file) ? { encoding: encodings.get(file) } : {}) })), summary }
}

/** Writes a worked-out patch. `before` is told each path first, so /undo can put it back. */
export async function writePatch(root: string, plan: PatchPlan, before?: (relative: string) => Promise<void>): Promise<string> {
  for (const write of plan.writes) {
    const target = resolveInside(root, write.path)
    assertWritable(path.relative(root, target))
  }
  for (const write of plan.writes) await before?.(write.path)
  for (const write of plan.writes) {
    const target = resolveInside(root, write.path)
    if (write.content === null) fs.rmSync(target, { force: true })
    else {
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, encodeText(write.content, write.encoding))
    }
  }
  return plan.summary.join(NEWLINE)
}

/** The paths a patch names, for the permission prompt and undo. */
export function patchPaths(text: string): { paths: string[]; deletes: boolean } {
  try {
    const ops = parsePatch(text)
    return { paths: [...new Set(ops.flatMap((op) => (op.kind === "update" && op.moveTo ? [op.path, op.moveTo] : [op.path])))], deletes: ops.some((op) => op.kind === "delete" || (op.kind === "update" && Boolean(op.moveTo))) }
  } catch {
    return { paths: [], deletes: false }
  }
}
