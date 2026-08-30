import fs from "node:fs/promises"
import path from "node:path"
import { resolveInside } from "./tools"

const BACKSLASH = String.fromCharCode(92)

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
export type Checkpoint = {
  label: string
  files: Snapshot[]
  /**
   * Directories that did not exist before this turn.
   *
   * Undoing a created file used to leave the folder it was created in
   * standing - empty, and no more wanted than the file was.
   */
  dirs: string[]
}

/** Enough to walk back through an afternoon, not enough to hoard a tree. */
const MAX_CHECKPOINTS = 20

/** The ancestors of a path that do not exist yet, outermost first. */
async function missingAncestors(root: string, relative: string): Promise<string[]> {
  const parts = relative.split(BACKSLASH).join("/").split("/").filter(Boolean)
  const missing: string[] = []
  for (let depth = 1; depth < parts.length; depth++) {
    const dir = parts.slice(0, depth).join("/")
    try {
      await fs.stat(resolveInside(root, dir))
    } catch {
      missing.push(dir)
    }
  }
  return missing
}

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
  // Deepest first, and rmdir only removes an empty directory - so a folder
  // that has since been given other contents is left alone.
  for (const dir of [...checkpoint.dirs].sort((a, b) => b.length - a.length)) {
    await fs.rmdir(resolveInside(root, dir)).catch(() => {})
  }

  return { label: checkpoint.label, files: inverse, dirs: checkpoint.dirs }
}

export class History {
  private done: Checkpoint[] = []
  private undone: Checkpoint[] = []
  private open: Checkpoint | undefined
  /**
   * How every file this session has touched looked before it did.
   *
   * Kept apart from the checkpoints on purpose. Checkpoints move as things
   * are undone and redone, but "what did this session do to my tree" is
   * answered against where the tree started, and that answer should not
   * change because somebody undid something in the middle.
   */
  private origin = new Map<string, string | null>()

  /** Start a turn. Nothing is kept unless the turn actually writes something. */
  begin(label: string) {
    this.open = { label: label.slice(0, 60), files: [], dirs: [] }
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
    for (const dir of await missingAncestors(root, relative)) {
      if (!this.open.dirs.includes(dir)) this.open.dirs.push(dir)
    }
    const before = await readOrNull(root, relative)
    if (!this.origin.has(relative)) this.origin.set(relative, before)
    this.open.files.push({ path: relative, before })
  }

  /** Every file this session has touched, and how it looked to begin with. */
  origins(): Map<string, string | null> {
    return new Map(this.origin)
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
    this.origin.clear()
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
