import fs from "node:fs/promises"
import { resolveInside } from "./tools"
import { diffFile, byImpact, countsOf, statusLetter, type FileDiff } from "./diff"
import type { History } from "./undo"

/**
 * What this session has done to the tree.
 *
 * The history already keeps every file's state from before the first time
 * the agent touched it, so this is that against what is on disk now. It is
 * deliberately not git: most of what wants reviewing was never committed,
 * and asking git would show a diff against the last commit rather than
 * against what the conversation started with.
 */

async function readOrNull(root: string, relative: string): Promise<string | null> {
  try {
    return await fs.readFile(resolveInside(root, relative), "utf8")
  } catch {
    return null
  }
}

export type Changes = {
  files: FileDiff[]
  added: number
  removed: number
}

export async function changesIn(root: string, history: History): Promise<Changes> {
  const files: FileDiff[] = []
  for (const [path, before] of history.origins()) {
    const after = await readOrNull(root, path)
    const diff = diffFile(path, before, after)
    // A file the agent wrote and then put back is not a change, and listing
    // it as one makes the list say more happened than did.
    if (diff.status === "unchanged") continue
    files.push(diff)
  }
  return {
    files: byImpact(files),
    added: files.reduce((total, file) => total + file.added, 0),
    removed: files.reduce((total, file) => total + file.removed, 0),
  }
}

/** "3 files  +120 -14", or a sentence when there is nothing to say. */
export function summarise(changes: Changes): string {
  if (!changes.files.length) return "no file has been changed this session"
  const count = changes.files.length + " file" + (changes.files.length === 1 ? "" : "s")
  const counts = [changes.added ? "+" + changes.added : "", changes.removed ? "-" + changes.removed : ""]
    .filter(Boolean)
    .join(" ")
  return count + "  " + counts
}

export { countsOf, statusLetter }
export type { FileDiff }
