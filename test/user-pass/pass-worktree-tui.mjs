// User pass: /worktree and /branch in the TUI.
import fs from "node:fs"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { check, failed, fakeModel, tempDir, tui, delay } from "./harness.mjs"
const git = (cwd, ...args) => spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true })
const project = tempDir("cg-wt-tui-")
git(project, "init", "-q", "-b", "main"); git(project, "config", "user.email", "t@example.invalid"); git(project, "config", "user.name", "T")
fs.writeFileSync(path.join(project, "a.txt"), "one\n"); git(project, "add", "."); git(project, "commit", "-q", "-m", "first"); git(project, "branch", "feature")
const model = await fakeModel(() => ({ text: "ok" }))
const t = await tui({ model, cwd: project })
try {
  t.write("/worktree new spike\r"); await delay(2500)
  const made = t.screen()
  check("TUI: /worktree new makes it and says how to open it", /made worktree spike on cg\/spike/.test(made) && /open it with: cgn/.test(made), made.split("\n").filter((l) => /worktree/.test(l)).slice(-2).join("\n"))
  t.clear(); t.write("/worktree\r"); await delay(1200)
  const list = t.screen()
  check("TUI: /worktree lists main and the new one", /Worktrees/.test(list) && /cg\/spike/.test(list) && /main/.test(list), list.split("\n").filter((l) => /spike|main/.test(l)).slice(-3).join("\n"))
  t.write("\x1b"); await delay(300)
  t.clear(); t.write("/branch\r"); await delay(1000)
  check("TUI: /branch lists branches with the current one marked", /Branches/.test(t.screen()) && /current\s+main/.test(t.screen()) && /feature/.test(t.screen()))
  t.write("\x1b"); await delay(300)
  t.clear(); t.write("/branch feature\r"); await delay(1200)
  check("TUI: /branch <name> switches", git(project, "branch", "--show-current").stdout.trim() === "feature" && /switched to feature/.test(t.screen()))
  fs.writeFileSync(path.join(project, "a.txt"), "dirty\n")
  t.clear(); t.write("/branch main\r"); await delay(1200)
  check("TUI: and refuses with uncommitted changes", git(project, "branch", "--show-current").stdout.trim() === "feature" && /uncommitted/.test(t.screen()))
} catch (error) { check("TUI pass", false, error.message) } finally { t.kill() }
model.close()
console.log(failed() ? `\n${failed()} failed` : "\nall passed")
process.exit(0)
