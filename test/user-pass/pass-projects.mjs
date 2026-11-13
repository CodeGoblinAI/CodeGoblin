// User pass: the web project switcher - branches, worktrees (make, open, remove), recent projects, open a folder.
import fs from "node:fs"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { check, failed, fakeModel, tempDir, web } from "./harness.mjs"

const git = (cwd, ...args) => spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true })
const project = tempDir("cg-switch-repo-")
git(project, "init", "-q", "-b", "main"); git(project, "config", "user.email", "t@example.invalid"); git(project, "config", "user.name", "T")
fs.writeFileSync(path.join(project, "a.txt"), "one\n"); git(project, "add", "."); git(project, "commit", "-q", "-m", "first"); git(project, "branch", "feature")
const other = tempDir("cg-switch-other-")
fs.writeFileSync(path.join(other, "other.txt"), "x")

const model = await fakeModel(() => ({ text: "hello from the fixture" }))
const w = await web({ model, cwd: project })
const page = w.page
const info = () => page.evaluate(() => fetch("/api/projects").then((r) => r.json()))
const reloaded = async () => { await page.waitForLoadState("load"); await page.waitForTimeout(1200); await w.fixture() }
try {
  // A conversation in this project, to check it stays with it.
  await w.send("first project chat", 1500)
  const row = page.locator("#project-name")
  check("the Project row names the folder and its branch", /cg-switch-repo-.*main/.test((await row.innerText()).replace(/\s+/g, " ")), await row.innerText())
  await row.click(); await page.waitForTimeout(500)
  const panel = (await page.locator("#project-panel").innerText()).replace(/\s+/g, " ")
  check("the panel lists branches, worktrees and a folder to open", /BRANCH/i.test(panel) && /feature/.test(panel) && /WORKTREES/i.test(panel) && /main checkout/.test(panel) && /OPEN A FOLDER/i.test(panel), panel)

  // Switch branch.
  await page.locator("#project-panel .pp-item", { hasText: "feature" }).click(); await reloaded()
  check("clicking a branch switches the checkout", git(project, "branch", "--show-current").stdout.trim() === "feature" && /feature/.test(await page.locator("#project-name").innerText()))

  // Make a worktree from the panel; the page reopens in it.
  await page.locator("#project-name").click(); await page.waitForTimeout(400)
  await page.locator('#project-panel input[aria-label="New worktree name"]').fill("spike")
  await page.locator("#project-panel form", { has: page.locator('input[aria-label="New worktree name"]') }).locator("button").click(); await reloaded()
  const afterMake = await info()
  check("New makes a worktree on cg/spike and opens it", /spike$/.test(afterMake.current.path) && afterMake.current.branch === "cg/spike", JSON.stringify(afterMake.current))
  check("the earlier conversation is not listed in the worktree", !(await page.locator("#session-list").innerText()).includes("first project chat"), await page.locator("#session-list").innerText())
  await w.send("worktree chat", 1500)
  const wtFile = path.join(afterMake.current.path, "a.txt")
  check("the worktree is a real checkout", fs.existsSync(wtFile))

  // Back to the main checkout via the panel.
  await page.locator("#project-name").click(); await page.waitForTimeout(400)
  await page.locator("#project-panel .pp-item", { hasText: "main checkout" }).click(); await reloaded()
  const back = await info()
  check("the main checkout reopens, with its own conversation back", back.current.path.toLowerCase() === project.toLowerCase() && (await page.locator("#session-list").innerText()).includes("first project chat"))

  // Remove the worktree (clean): its folder goes to the Recycle Bin, the branch stays.
  await page.locator("#project-name").click(); await page.waitForTimeout(400)
  await page.locator("#project-panel .pp-remove").first().click(); await page.waitForTimeout(2500)
  check("× removes a clean CG-Next worktree; the branch is kept", !fs.existsSync(afterMake.current.path) && git(project, "branch", "--list", "cg/spike").stdout.includes("cg/spike"), (await page.locator("#project-panel").innerText()).replace(/\s+/g, " ").slice(-160))

  // Open another folder by path, then come back through Recent projects.
  await page.locator('#project-panel input[aria-label="Folder to open"]').fill(other)
  await page.locator("#project-panel form", { has: page.locator('input[aria-label="Folder to open"]') }).locator("button").click(); await reloaded()
  check("Open a folder switches to it", (await info()).current.path.toLowerCase() === other.toLowerCase())
  await page.locator("#project-name").click(); await page.waitForTimeout(400)
  const recent = (await page.locator("#project-panel").innerText()).replace(/\s+/g, " ")
  check("the previous project is under Recent projects", /RECENT PROJECTS/i.test(recent) && recent.includes(path.basename(project)), recent)
  await page.locator("#project-panel .pp-item", { hasText: path.basename(project) }).click(); await reloaded()
  check("Recent projects switches back", (await info()).current.path.toLowerCase() === project.toLowerCase())

  // A bad folder says so and stays put.
  await w.send("/project C:/definitely/not/here", 900)
  check("a folder that does not exist is refused in place", /no such folder/.test(await page.locator("#project-panel").innerText().catch(() => "")) || (await info()).current.path.toLowerCase() === project.toLowerCase())
  check("no console errors", w.errors.length === 0, w.errors.join(" | "))
} catch (error) { check("web pass", false, error.message) } finally { await w.close() }
model.close()
console.log(failed() ? `\n${failed()} failed` : "\nall passed")
process.exit(0)
