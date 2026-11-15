// User pass: the approval mode (ask / approve for me / full access) is the one the app was left in.
// Terminal: shift+tab to change it, close, open again - same mode, and it says so. Then the web app opens in
// that mode too (they share the settings), and a change made there is what the next page opens in.
import fs from "node:fs"
import path from "node:path"
import { check, failed, fakeModel, tempDir, tui, web, delay, plain } from "./harness.mjs"

const model = await fakeModel(() => ({ text: "noted" }))
const profile = tempDir("cg-pass-profile-")
const project = tempDir("cg-mode-project-")
const screenOf = (t) => plain(t.out.split("\x1b[2J").at(-1)).replace(/\r/g, "")
const waitFor = async (t, pattern, ms = 10000) => { for (let waited = 0; waited < ms; waited += 200) { if (pattern.test(screenOf(t))) return true; await delay(200) } return false }
const stored = () => { const file = path.join(profile, "state", "settings.json"); return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {} }
const statusRow = (t) => screenOf(t).split("\n").filter((line) => /Local server fixture/.test(line)).at(-1) ?? ""

let t = await tui({ model, cwd: project, profile, cols: 110, rows: 30 })
try {
  await waitFor(t, /ask · /)
  check("a first start is in ask mode", /^\s*ask · /.test(statusRow(t)), statusRow(t))
  t.write("\x1b[Z"); await delay(500)
  check("shift+tab moves to approve for me", /approve for me · /.test(statusRow(t)), statusRow(t))
  check("and that is saved", stored().approvalMode === "approve", JSON.stringify(stored().approvalMode))
  t.write("\x1b[Z"); await delay(500)
  check("again: full access, saved", /full access · /.test(statusRow(t)) && stored().approvalMode === "full", statusRow(t) + " " + stored().approvalMode)
} catch (error) { check("mode pass", false, error.message) } finally { t.kill() }
await delay(500)

t = await tui({ model, cwd: project, profile, cols: 110, rows: 30 })
try {
  check("opened again, it is in full access", await waitFor(t, /full access · Local server fixture/), statusRow(t))
  check("and says that this is how it was left", /approvals: full access, as you left it - shift\+tab changes it/.test(screenOf(t)), screenOf(t).split("\n").filter((l) => /approvals/.test(l)).join(" | "))
  t.write("\x1b[Z"); await delay(500)
  check("shift+tab from full access is ask again, saved", /^\s*ask · /.test(statusRow(t)) && stored().approvalMode === "ask", statusRow(t) + " " + stored().approvalMode)
  t.write("\x1b[Z"); await delay(500)
} catch (error) { check("reopen pass", false, error.message) } finally { t.kill() }
await delay(500)

// The web app: opens in the mode the terminal was left in (approve for me), and remembers its own change.
const modeOf = (w) => w.page.evaluate(() => document.querySelector("#mode-btn .picker-label")?.textContent?.trim() ?? "")
let w = await web({ model, cwd: project, profile })
try {
  await w.page.waitForTimeout(800)
  const opened = await modeOf(w)
  check("the web app opens in the mode the terminal was left in", /approve/i.test(opened), opened)
  await w.page.click("#mode-btn")
  await w.page.locator("#mode-menu .picker-item", { hasText: /full access/i }).first().click()
  await w.page.waitForTimeout(700)
  check("choosing full access in the browser is saved", stored().approvalMode === "full", JSON.stringify(stored().approvalMode))
  await w.page.reload(); await w.page.waitForTimeout(1500)
  const again = await modeOf(w)
  check("and a page opened fresh is in full access, marked as such", /full access/i.test(again) && await w.page.evaluate(() => document.getElementById("mode-btn").classList.contains("full")), again)
  check("no console errors", w.errors.length === 0, w.errors.join(" | "))
} catch (error) { check("web mode pass", false, error.message) } finally { await w.close() }

model.close()
process.stdout.write((failed() ? `\n${failed()} failed` : "\nall passed") + "\n", () => process.kill(process.pid, "SIGKILL"))
