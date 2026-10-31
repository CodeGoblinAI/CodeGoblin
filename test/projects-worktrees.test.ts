import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { recentProjects, rememberProject } from "../src/core/projects"
import { createWorktree, currentBranch, listWorktrees, localBranches, removeWorktree, switchBranch, worktreeHome } from "../src/core/worktrees"
import { create, list, save } from "../src/core/sessions"
import { runCommand } from "../src/core/commands"

const git = (cwd: string, ...args: string[]) => spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true })
function repo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cg-repo-"))
  git(dir, "init", "-q", "-b", "main")
  git(dir, "config", "user.email", "test@example.invalid")
  git(dir, "config", "user.name", "Test")
  fs.writeFileSync(path.join(dir, "a.txt"), "one\n")
  git(dir, "add", ".")
  git(dir, "commit", "-q", "-m", "first")
  return dir
}
/** Stands in for the Recycle Bin in tests: moves the folder aside rather than deleting it. */
const trash = fs.mkdtempSync(path.join(os.tmpdir(), "cg-trash-"))
const recycle = (dir: string) => fs.renameSync(dir, path.join(trash, path.basename(dir) + "-" + Date.now()))

describe("recent projects", () => {
  test("newest first, no repeats, and folders that are gone drop out", () => {
    const a = fs.mkdtempSync(path.join(os.tmpdir(), "cg-proj-a-"))
    const b = fs.mkdtempSync(path.join(os.tmpdir(), "cg-proj-b-"))
    rememberProject(a, 1)
    rememberProject(b, 2)
    rememberProject(a, 3)
    rememberProject(path.join(os.tmpdir(), "cg-never-existed-" + Date.now()), 4)
    const recent = recentProjects().filter((p) => p.path === a || p.path === b)
    expect(recent.map((p) => p.path)).toEqual([a, b])
    expect(recentProjects().some((p) => p.path.includes("cg-never-existed-"))).toBe(false)
  })
})

describe("sessions belong to a project", () => {
  test("a project's list has its own conversations and older ones that never said", async () => {
    const here = fs.mkdtempSync(path.join(os.tmpdir(), "cg-here-"))
    const there = fs.mkdtempSync(path.join(os.tmpdir(), "cg-there-"))
    const mine = create("p", "m", here); mine.title = "mine"; await save(mine)
    const theirs = create("p", "m", there); theirs.title = "theirs"; await save(theirs)
    const legacy = create("p", "m"); delete legacy.root; legacy.title = "legacy"; await save(legacy)
    const titles = (await list(500, here)).map((s) => s.title)
    expect(titles).toContain("mine")
    expect(titles).toContain("legacy")
    expect(titles).not.toContain("theirs")
    expect((await list(500)).map((s) => s.title)).toContain("theirs")
  })
})

describe("worktrees", () => {
  test("made on cg/<name> under CG-Next's own folder, listed, and removed only when clean", () => {
    const dir = repo()
    const made = createWorktree(dir, "try-thing")
    expect(made.branch).toBe("cg/try-thing")
    expect(made.path.startsWith(worktreeHome(dir))).toBe(true)
    expect(fs.existsSync(path.join(made.path, "a.txt"))).toBe(true)
    const trees = listWorktrees(dir)
    expect(trees.map((t) => [t.main, t.ours, t.branch])).toEqual([[true, false, "main"], [false, true, "cg/try-thing"]])
    // Listed the same from inside the worktree.
    expect(listWorktrees(made.path).length).toBe(2)
    expect(() => createWorktree(dir, "try-thing")).toThrow("already exists")
    expect(() => createWorktree(dir, "../escape")).toThrow("a worktree name")

    fs.writeFileSync(path.join(made.path, "wip.txt"), "unsaved\n")
    expect(() => removeWorktree(dir, made.path, { recycle })).toThrow("uncommitted")
    expect(() => removeWorktree(dir, dir, { recycle })).toThrow("main checkout is never removed")
    fs.renameSync(path.join(made.path, "wip.txt"), path.join(trash, "wip-" + Date.now() + ".txt"))
    removeWorktree(dir, made.path, { recycle })
    expect(fs.existsSync(made.path)).toBe(false)
    expect(listWorktrees(dir).length).toBe(1)
    // The branch stays: removing a worktree loses no commits.
    expect(localBranches(dir)).toContain("cg/try-thing")
  })

  test("a worktree CG-Next did not make is never removed here", () => {
    const dir = repo()
    const elsewhere = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cg-other-")), "wt")
    git(dir, "worktree", "add", "-q", "-b", "theirs", elsewhere)
    expect(() => removeWorktree(dir, elsewhere, { recycle })).toThrow("only worktrees CG-Next made")
    expect(fs.existsSync(elsewhere)).toBe(true)
  })

  test("outside a repository there is nothing to list or make", () => {
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), "cg-plain-"))
    expect(listWorktrees(plain)).toEqual([])
    expect(() => createWorktree(plain, "x")).toThrow("not in a git repository")
  })
})

describe("branches", () => {
  test("switches only between existing branches with nothing uncommitted", () => {
    const dir = repo()
    git(dir, "branch", "feature")
    expect(localBranches(dir).sort()).toEqual(["feature", "main"])
    switchBranch(dir, "feature")
    expect(currentBranch(dir)).toBe("feature")
    fs.writeFileSync(path.join(dir, "a.txt"), "changed\n")
    expect(() => switchBranch(dir, "main")).toThrow("uncommitted")
    expect(currentBranch(dir)).toBe("feature")
    expect(() => switchBranch(dir, "nope")).toThrow("no local branch")
    expect(() => switchBranch(dir, "--force")).toThrow("not a branch name")
  })
})

describe("the commands", () => {
  test("/project, /worktree and /branch", () => {
    expect(runCommand("/project")).toEqual({ kind: "project" })
    expect(runCommand("/project C:/code/x")).toEqual({ kind: "project", path: "C:/code/x" })
    expect(runCommand("/worktree")).toEqual({ kind: "worktree", action: "list" })
    expect(runCommand("/worktree new spike")).toEqual({ kind: "worktree", action: "new", name: "spike" })
    expect(runCommand("/worktree nonsense")).toMatchObject({ kind: "message" })
    expect(runCommand("/branches")).toEqual({ kind: "branch" })
    expect(runCommand("/branch main")).toEqual({ kind: "branch", name: "main" })
  })
})
