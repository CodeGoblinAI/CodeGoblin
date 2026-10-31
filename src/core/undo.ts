import fs from "node:fs/promises"
import path from "node:path"
import crypto from "node:crypto"
import { readFileSync, realpathSync } from "node:fs"
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
 * Snapshots live in memory, and the recent ones are saved with the
 * conversation (within the same limits as the diff baseline), so /undo still
 * works after a restart or a resume. Each checkpoint remembers what the files
 * looked like when its turn ended: if one has changed since - edited by hand,
 * or by a later turn that is no longer in memory - undo refuses rather than
 * overwrite work it never saw.
 */

/** before is null when the file did not exist, so undo removes it again. */
export type Snapshot = { path: string; before: string | null }
export type Checkpoint = {
  label: string
  files: Snapshot[]
  /**
   * A hash of each file as the turn left it, in the same order as files; null
   * for a file the turn left absent. Undo checks the tree still matches.
   */
  after?: (string | null)[]
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
export type ReviewState = { root: string; files: Snapshot[]; truncated?: boolean; checkpoints?: { done: Checkpoint[]; undone: Checkpoint[] } }
/** What is saved of the undo stacks: newest first until either limit, so the most recent turns always survive. */
const SAVED_UNDO_BYTES = 4 * 1024 * 1024
const SAVED_UNDO_FILE_BYTES = 512 * 1024
const HASH = /^[0-9a-f]{64}$/
const REVIEW_FILES = 100
const REVIEW_BYTES = 4 * 1024 * 1024
const REVIEW_FILE_BYTES = 256 * 1024
const rootIdentity = (root: string) => process.platform === "win32" ? realpathSync(root).toLowerCase() : realpathSync(root)

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

const hashOf = (text: string | null) => (text === null ? null : crypto.createHash("sha256").update(text).digest("hex"))

function readOrNullSync(root: string, relative: string): string | null {
  try {
    return readFileSync(resolveInside(root, relative), "utf8")
  } catch {
    return null
  }
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
  // Checked before anything is written, so a refusal leaves every file as it was.
  if (checkpoint.after) {
    const changed: string[] = []
    for (const [index, snapshot] of checkpoint.files.entries()) {
      if (hashOf(await readOrNull(root, snapshot.path)) !== checkpoint.after[index]) changed.push(snapshot.path)
    }
    if (changed.length) {
      throw new Error(`${changed.slice(0, 3).join(", ")}${changed.length > 3 ? ` and ${changed.length - 3} more` : ""} changed since that turn - nothing was put back, so those edits are safe`)
    }
  }
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

  // What the tree now holds is what was just written: the redo checks against that.
  return { label: checkpoint.label, files: inverse, dirs: checkpoint.dirs, after: checkpoint.files.map((snapshot) => hashOf(snapshot.before)) }
}

const sizeOf = (checkpoint: Checkpoint) => checkpoint.files.reduce((sum, snapshot) => sum + (snapshot.before === null ? 0 : Buffer.byteLength(snapshot.before)), 0)

/** A saved checkpoint, checked field by field: anything off and it is not used. */
function validCheckpoint(root: string, value: unknown): Checkpoint | undefined {
  const raw = value as Partial<Checkpoint> | null
  if (!raw || typeof raw.label !== "string" || !Array.isArray(raw.files) || !raw.files.length || !Array.isArray(raw.dirs) || !Array.isArray(raw.after)) return undefined
  if (raw.after.length !== raw.files.length) return undefined
  const inside = (relative: unknown) => {
    if (typeof relative !== "string" || !relative || path.isAbsolute(relative)) return false
    try { resolveInside(root, relative); return true } catch { return false }
  }
  for (const snapshot of raw.files) {
    if (!snapshot || !inside(snapshot.path) || (snapshot.before !== null && typeof snapshot.before !== "string")) return undefined
    if (snapshot.before !== null && Buffer.byteLength(snapshot.before) > SAVED_UNDO_FILE_BYTES) return undefined
  }
  if (!raw.dirs.every(inside)) return undefined
  if (!raw.after.every((hash) => hash === null || (typeof hash === "string" && HASH.test(hash)))) return undefined
  return { label: raw.label.slice(0, 60), files: raw.files.map((snapshot) => ({ path: snapshot.path, before: snapshot.before })), dirs: [...raw.dirs], after: [...raw.after] }
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
  reviewNotice?: string

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

  /**
   * What is saved with the conversation: the diff baselines, and the undo and
   * redo stacks newest first until the size limit. Bound to this physical
   * workspace; a different folder gets neither back.
   */
  reviewState(root: string): ReviewState {
    const state = this.baselineState(root)
    let budget = SAVED_UNDO_BYTES
    const keep = (stack: Checkpoint[]) => {
      const kept: Checkpoint[] = []
      for (const checkpoint of [...stack].reverse()) {
        const size = sizeOf(checkpoint)
        // An older checkpoint cannot be undone without the newer ones, so the
        // first that does not fit ends the stack.
        if (!checkpoint.after || size > budget || checkpoint.files.some((s) => s.before !== null && Buffer.byteLength(s.before) > SAVED_UNDO_FILE_BYTES)) break
        budget -= size
        kept.unshift(checkpoint)
      }
      return kept
    }
    const done = keep(this.done)
    const undone = keep(this.undone)
    return done.length || undone.length ? { ...state, checkpoints: { done, undone } } : state
  }

  private baselineState(root: string): ReviewState {
    const files: Snapshot[] = []
    let bytes = 0
    let truncated = Boolean(this.reviewNotice)
    for (const [relative, before] of this.origin) {
      const size = before === null ? 0 : Buffer.byteLength(before)
      if (files.length >= REVIEW_FILES || size > REVIEW_FILE_BYTES || bytes + size > REVIEW_BYTES) { truncated = true; continue }
      try {
        files.push({ path: path.relative(root, resolveInside(root, relative)), before })
        bytes += size
      } catch { truncated = true }
    }
    return { root: rootIdentity(root), files, ...(truncated ? { truncated: true } : {}) }
  }

  restoreReview(root: string, input: unknown) {
    if (!input) return
    const state = input as Partial<ReviewState>
    if (state.root !== rootIdentity(root) || !Array.isArray(state.files) || state.files.length > REVIEW_FILES) {
      this.reviewNotice = "Saved diff baseline unavailable for this workspace; no external paths were loaded."
      return
    }
    const restored = new Map<string, string | null>()
    let bytes = 0
    for (const snapshot of state.files) {
      if (!snapshot || typeof snapshot.path !== "string" || !snapshot.path || path.isAbsolute(snapshot.path) || (snapshot.before !== null && typeof snapshot.before !== "string")) {
        this.reviewNotice = "Saved diff baseline invalid; no baseline was restored."
        return
      }
      const size = snapshot.before === null ? 0 : Buffer.byteLength(snapshot.before)
      if (size > REVIEW_FILE_BYTES || bytes + size > REVIEW_BYTES) { this.reviewNotice = "Saved diff baseline exceeds limits; no baseline was restored."; return }
      try { resolveInside(root, snapshot.path) } catch { this.reviewNotice = "Saved diff path is outside this workspace; no baseline was restored."; return }
      bytes += size
      restored.set(snapshot.path, snapshot.before)
    }
    this.origin = restored
    this.reviewNotice = state.truncated ? "Saved diff is incomplete: some baselines exceeded limits or were unavailable." : undefined
    const saved = state.checkpoints
    if (saved && Array.isArray(saved.done) && Array.isArray(saved.undone) && saved.done.length + saved.undone.length <= MAX_CHECKPOINTS * 2) {
      const done = saved.done.map((each) => validCheckpoint(root, each))
      const undone = saved.undone.map((each) => validCheckpoint(root, each))
      if (done.every(Boolean) && undone.every(Boolean)) {
        this.done = done as Checkpoint[]
        this.undone = undone as Checkpoint[]
      } else this.reviewNotice = "Saved undo history was invalid, so /undo starts fresh; /diff keeps the baseline."
    }
  }

  /** End a turn. A turn that changed nothing leaves no checkpoint to undo. */
  commit(root?: string) {
    if (this.open && this.open.files.length) {
      // How the turn left each file, so a later undo can tell whether anything
      // has touched them since. Without a root nothing is checked, as before.
      if (root) this.open.after = this.open.files.map((snapshot) => hashOf(readOrNullSync(root, snapshot.path)))
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
    try {
      this.undone.push(await restore(root, checkpoint))
    } catch (error) {
      // Refused, so it stays where it was: fixing the file and trying again works.
      this.done.push(checkpoint)
      throw error
    }
    return checkpoint
  }

  async redo(root: string): Promise<Checkpoint | undefined> {
    const checkpoint = this.undone.pop()
    if (!checkpoint) return undefined
    try {
      this.done.push(await restore(root, checkpoint))
    } catch (error) {
      this.undone.push(checkpoint)
      throw error
    }
    return checkpoint
  }

  reset() {
    this.done = []
    this.undone = []
    this.open = undefined
    this.origin.clear()
    this.reviewNotice = undefined
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
  if (history.origins().size) return "nothing left to undo - older turns were past the saved limit; /diff shows what this session changed"
  return "nothing to undo - no file has been changed this session"
}

/** "3 files (src/a.ts, src/b.ts, ...)" - what actually changed, for the status line. */
export function describe(checkpoint: Checkpoint): string {
  const names = checkpoint.files.map((snapshot) => snapshot.path)
  const shown = names.slice(0, 3).join(", ")
  const rest = names.length > 3 ? `, +${names.length - 3} more` : ""
  return `${names.length} file${names.length === 1 ? "" : "s"} (${shown}${rest})`
}
