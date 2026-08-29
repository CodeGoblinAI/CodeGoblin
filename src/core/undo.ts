import fs from "node:fs/promises"
import path from "node:path"
import { resolveInside } from "./tools"

/**
 * Taking back what the agent wrote.
 *
 * A model that edits four files and gets the third one wrong is a normal
 * afternoon, and "git checkout" is not an answer when the work in progress
 * was never committed. Every turn that touches a file opens a checkpoint,
 * the state before each file is captured once, and /undo puts it all back.
 *
 * Snapshots live in memory for the life of the process. They are not a
 * backup: closing the app loses them, which is the honest trade for not
 * scattering copies of someone's source tree across a state directory.
 */

/** before is null when the file did not exist, so undo removes it again. */
export type Snapshot = { path: string; before: string | null }
export type Checkpoint = { label: string; files: Snapshot[] }

/** Enough to walk back through an afternoon, not enough to hoard a tree. */
const MAX_CHECKPOINTS = 20

async function readOrNull(root: string, relative: string): Promise<string | null> {
  try {
    return await fs.readFile(resolveInside(root, relative), "utf8")
  } catch {
    return null
  }
}

/** Put a checkpoint's files back, returning what was there so it can be replayed. */
async function restore(root: string, checkpoint: Checkpoint): Promise<Checkpoint> {
  const inverse: Snapshot[] = []
  for (const snapshot of checkpoint.files) {
    inverse.push({ path: snapshot.path, before: await readOrNull(root, snapshot.path) })
    const target = resolveInside(root, snapshot.path)
    if (snapshot.before === null) {
      await fs.rm(target, { force: true })
      continue
    }
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, snapshot.before, "utf8")
  }
  return { label: checkpoint.label, files: inverse }
}

export class History {
  private done: Checkpoint[] = []
  private undone: Checkpoint[] = []
  private open: Checkpoint | undefined

  /** Start a turn. Nothing is kept unless the turn actually writes something. */
  begin(label: string) {
    this.open = { label: label.slice(0, 60), files: [] }
  }

  /**
   * Capture a file about to be written.
   *
   * Only the first capture of a file in a turn counts: a turn that edits the
   * same file three times should undo to how it started, not to the second
   * edit.
   */
  async record(root: string, relative: string) {
    if (!this.open) return
    // A path that escapes the root is about to be refused by the tool itself,
    // so there is nothing to put back. Capturing it anyway would leave an
    // entry undo could only throw on, abandoning the rest of the restore.
    try {
      resolveInside(root, relative)
    } catch {
      return
    }
    if (this.open.files.some((snapshot) => snapshot.path === relative)) return
    this.open.files.push({ path: relative, before: await readOrNull(root, relative) })
  }

  /** End a turn. A turn that changed nothing leaves no checkpoint to undo. */
  commit() {
    if (this.open && this.open.files.length) {
      this.done.push(this.open)
      if (this.done.length > MAX_CHECKPOINTS) this.done.shift()
      // New work forks the timeline: what was undone can no longer be redone.
      this.undone = []
    }
    this.open = undefined
  }

  canUndo() {
    return this.done.length > 0
  }
  canRedo() {
    return this.undone.length > 0
  }

  async undo(root: string): Promise<Checkpoint | undefined> {
    const checkpoint = this.done.pop()
    if (!checkpoint) return undefined
    this.undone.push(await restore(root, checkpoint))
    return checkpoint
  }

  async redo(root: string): Promise<Checkpoint | undefined> {
    const checkpoint = this.undone.pop()
    if (!checkpoint) return undefined
    this.done.push(await restore(root, checkpoint))
    return checkpoint
  }

  reset() {
    this.done = []
    this.undone = []
    this.open = undefined
  }
}

/**
 * Why there was nothing to do.
 *
 * "nothing to undo" is true but unhelpful once a session has undone its way
 * back to the start - files were changed, they are simply all back already.
 */
export function nothingToDo(history: History, forward: boolean): string {
  if (forward) return "nothing to redo"
  if (history.canRedo()) return "already back to how this session started - /redo to reapply"
  return "nothing to undo - no file has been changed this session"
}

/** "3 files (src/a.ts, src/b.ts, ...)" - what actually changed, for the status line. */
export function describe(checkpoint: Checkpoint): string {
  const names = checkpoint.files.map((snapshot) => snapshot.path)
  const shown = names.slice(0, 3).join(", ")
  const rest = names.length > 3 ? `, +${names.length - 3} more` : ""
  return `${names.length} file${names.length === 1 ? "" : "s"} (${shown}${rest})`
}
