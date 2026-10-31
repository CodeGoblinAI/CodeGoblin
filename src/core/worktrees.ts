import fs from "node:fs"
import path from "node:path"
import crypto from "node:crypto"
import { spawnSync } from "node:child_process"
import { Global } from "../platform/paths"

/**
 * Git worktrees and branches, for working on something in a separate checkout.
 *
 * The fork's web app can start a session in its own worktree, so an agent's
 * experiment never touches the checkout you are working in. Worktrees made
 * here live under CG-Next's data folder, one folder per repository, on a
 * branch named cg/<name>.
 *
 * Removing one never deletes anything permanently: on Windows the folder goes
 * to the Recycle Bin and git is told to forget it, and a worktree with
 * uncommitted changes is not removed at all.
 */
export type Worktree = { path: string; branch?: string; head?: string; main: boolean; ours: boolean }

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/

function git(cwd: string, args: string[], timeout = 20_000): { ok: boolean; out: string; err: string } {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true, timeout })
  return { ok: result.status === 0, out: (result.stdout ?? "").trim(), err: (result.stderr ?? "").trim() || (result.error?.message ?? "") }
}

/** The top of the repository a folder is in, or undefined outside one. */
export function repoRoot(folder: string): string | undefined {
  const result = git(folder, ["rev-parse", "--show-toplevel"])
  return result.ok && result.out ? path.resolve(result.out) : undefined
}

/** Where this repository's CG-Next worktrees go: a folder per repository under the data folder. */
export function worktreeHome(repo: string): string {
  const id = crypto.createHash("sha256").update(path.resolve(repo).toLowerCase()).digest("hex").slice(0, 8)
  return path.join(Global.Path.data, "worktrees", path.basename(repo) + "-" + id)
}

const under = (child: string, parent: string) => {
  const relative = path.relative(parent, child)
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative)
}

export function listWorktrees(folder: string): Worktree[] {
  const repo = repoRoot(folder)
  if (!repo) return []
  const result = git(repo, ["worktree", "list", "--porcelain"])
  if (!result.ok) return []
  const home = worktreeHome(mainCheckout(repo) ?? repo)
  const list: Worktree[] = []
  let current: Partial<Worktree> | undefined
  for (const line of (result.out + "\n\n").split(/\r?\n/)) {
    if (line.startsWith("worktree ")) current = { path: path.resolve(line.slice(9)) }
    else if (current && line.startsWith("HEAD ")) current.head = line.slice(5, 12)
    else if (current && line.startsWith("branch ")) current.branch = line.slice(7).replace(/^refs\/heads\//, "")
    else if (current && line === "" && current.path) {
      list.push({ path: current.path, branch: current.branch, head: current.head, main: list.length === 0, ours: under(current.path, home) })
      current = undefined
    }
  }
  return list
}

/** The repository's main checkout, which a linked worktree points back to. */
function mainCheckout(repo: string): string | undefined {
  const result = git(repo, ["worktree", "list", "--porcelain"])
  const first = result.ok ? result.out.split(/\r?\n/).find((line) => line.startsWith("worktree ")) : undefined
  return first ? path.resolve(first.slice(9)) : undefined
}

/** Makes a worktree on branch cg/<name> (reusing the branch if it exists) and returns its folder. */
export function createWorktree(folder: string, name: string): Worktree {
  if (!NAME.test(name)) throw new Error("a worktree name is letters, numbers, dot, dash or underscore, up to 40")
  const repo = repoRoot(folder)
  if (!repo) throw new Error("this folder is not in a git repository")
  const main = mainCheckout(repo) ?? repo
  const target = path.join(worktreeHome(main), name)
  if (fs.existsSync(target)) throw new Error(`a worktree called ${name} already exists`)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  const branch = "cg/" + name
  const exists = git(repo, ["rev-parse", "--verify", "--quiet", "refs/heads/" + branch]).ok
  const result = git(repo, exists ? ["worktree", "add", target, branch] : ["worktree", "add", "-b", branch, target], 60_000)
  if (!result.ok) throw new Error("git could not make the worktree: " + result.err.split(/\r?\n/).at(-1))
  return { path: path.resolve(target), branch, main: false, ours: true }
}

/** Uncommitted changes in a checkout, as git's short status lines. */
export function uncommitted(folder: string): string[] {
  const result = git(folder, ["status", "--porcelain"])
  return result.ok ? result.out.split(/\r?\n/).filter(Boolean) : ["(git status failed)"]
}

/**
 * Removes a worktree CG-Next made. Never the main checkout, never one with
 * uncommitted changes, never a folder outside CG-Next's worktree home, and
 * never a permanent delete: on Windows the folder goes to the Recycle Bin.
 */
export function removeWorktree(folder: string, target: string, options: { recycle?: (dir: string) => void } = {}): void {
  const resolved = path.resolve(target)
  const tree = listWorktrees(folder).find((each) => path.resolve(each.path).toLowerCase() === resolved.toLowerCase())
  if (!tree) throw new Error("that is not a worktree of this repository")
  if (tree.main) throw new Error("the main checkout is never removed")
  if (!tree.ours) throw new Error("only worktrees CG-Next made are removed here; remove that one yourself")
  const dirty = uncommitted(resolved)
  if (dirty.length) throw new Error(`it has ${dirty.length} uncommitted change${dirty.length === 1 ? "" : "s"}; commit or discard them first`)
  const repo = repoRoot(folder)!
  if (options.recycle) {
    options.recycle(resolved)
    git(repo, ["worktree", "prune"])
  } else if (process.platform === "win32") {
    const script = "Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($env:CG_TARGET, 'OnlyErrorDialogs', 'SendToRecycleBin')"
    // Windows can hold a just-used folder for a moment (git, the indexer), so a few tries.
    let result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { env: { ...process.env, CG_TARGET: resolved }, windowsHide: true, encoding: "utf8", timeout: 60_000 })
    for (let attempt = 0; attempt < 3 && fs.existsSync(resolved); attempt++) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 700)
      result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { env: { ...process.env, CG_TARGET: resolved }, windowsHide: true, encoding: "utf8", timeout: 60_000 })
    }
    if (result.status !== 0 || fs.existsSync(resolved)) throw new Error("could not move it to the Recycle Bin: " + ((result.stderr ?? "").trim().split(/\r?\n/).at(-1) || "unknown"))
    git(repo, ["worktree", "prune"])
  } else {
    const result = git(repo, ["worktree", "remove", resolved])
    if (!result.ok) throw new Error("git could not remove it: " + result.err.split(/\r?\n/).at(-1))
  }
}

export function currentBranch(folder: string): string | undefined {
  const result = git(folder, ["branch", "--show-current"])
  return result.ok && result.out ? result.out : undefined
}

export function localBranches(folder: string): string[] {
  const result = git(folder, ["for-each-ref", "--sort=-committerdate", "--format=%(refname:short)", "refs/heads/"])
  return result.ok ? result.out.split(/\r?\n/).filter(Boolean).slice(0, 50) : []
}

/** Switches the checkout's branch - only when nothing is uncommitted, so no work is carried or lost. */
export function switchBranch(folder: string, branch: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/.test(branch) || branch.includes("..")) throw new Error("not a branch name")
  if (!localBranches(folder).includes(branch)) throw new Error(`there is no local branch called ${branch}`)
  const dirty = uncommitted(folder)
  if (dirty.length) throw new Error(`there ${dirty.length === 1 ? "is 1 uncommitted change" : `are ${dirty.length} uncommitted changes`}; commit or stash first`)
  const result = git(folder, ["switch", branch])
  if (!result.ok) throw new Error("git could not switch: " + result.err.split(/\r?\n/).at(-1))
}
