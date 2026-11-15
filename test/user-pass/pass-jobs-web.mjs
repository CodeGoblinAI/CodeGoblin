// User pass, web app: background jobs. The model starts a dev server in the background; a chip under the
// prompt says a job is running; clicking it (or /jobs) lists the job with its output and a Stop button.
import fs from "node:fs"
import path from "node:path"
import { check, failed, fakeModel, tempDir, web } from "./harness.mjs"

const project = tempDir("cg-jobsweb-project-")
fs.writeFileSync(path.join(project, "server.js"), "require('fs').appendFileSync('pids.txt', process.pid + '\\n'); console.log('starting'); setTimeout(() => console.log('Ready on http://localhost:4000'), 2500); let n = 0; setInterval(() => console.log('tick ' + ++n), 500)")
const pids = () => fs.existsSync(path.join(project, "pids.txt")) ? fs.readFileSync(path.join(project, "pids.txt"), "utf8").trim().split("\n").map(Number) : []
const alive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }

const model = await fakeModel(async (sent) => {
  const last = sent.messages.at(-1); const text = String(last?.content ?? "")
  if (last?.role === "tool" && /started job\d+ in the background/.test(text)) return { tool: "job_output", args: { id: /started (job\d+)/.exec(text)[1], until: "ready on" } }
  if (last?.role === "tool") return { text: "The server is up on port 4000." }
  return { tool: "shell", args: { command: "bun server.js", background: true } }
})

const w = await web({ model, cwd: project })
const chip = w.page.locator("#jobs-chip")
try {
  check("with nothing running there is no chip", !(await chip.isVisible()))
  await w.box.fill("/jobs"); await w.page.keyboard.press("Enter"); await w.page.waitForTimeout(700)
  const empty = await w.page.locator("dialog.jobs").innerText().catch(() => "")
  check("/jobs with nothing running says what jobs are", /No background jobs/.test(empty) && /dev server/.test(empty), empty)
  await w.page.locator("dialog.jobs").getByRole("button", { name: "Close" }).click(); await w.page.waitForTimeout(300)

  await w.box.fill("start the server"); await w.page.keyboard.press("Enter")
  const prompt = w.page.locator(".permission").last()
  await prompt.waitFor({ timeout: 10000 })
  const asked = await prompt.innerText()
  check("the approval says the command will keep running", /bun server\.js/.test(asked) && /kept running in the background/.test(asked), asked.replace(/\n+/g, " | "))
  await prompt.getByRole("button", { name: "Allow once" }).click()
  await w.page.waitForFunction(() => /The server is up on port 4000/.test(document.querySelector(".thread")?.textContent ?? ""), null, { timeout: 25000 }).catch(() => {})
  check("the answer arrives once the server is ready", /The server is up on port 4000/.test(await w.page.locator(".thread").innerText()))
  await w.page.waitForTimeout(600)
  check("a chip under the prompt says one job is running", (await chip.isVisible()) && /^1 job running$/.test((await chip.innerText()).trim()), await chip.innerText().catch(() => "hidden"))
  const pid = pids()[0]
  check("the server is a real process, still running after the turn", pid > 0 && alive(pid), String(pid))

  await chip.click(); await w.page.waitForTimeout(900)
  const dialog = w.page.locator("dialog.jobs")
  const listed = await dialog.innerText()
  check("clicking the chip lists the job, its state and its output", /bun server\.js/.test(listed) && /job1 · running \d+s/.test(listed) && /tick \d+/.test(listed) && /Ready on http:\/\/localhost:4000/.test(listed), listed.replace(/\n+/g, " | ").slice(0, 300))
  const before = await dialog.locator(".job pre").first().innerText()
  await w.page.waitForTimeout(2600)
  check("the output keeps up while the dialog is open", (await dialog.locator(".job pre").first().innerText()) !== before)
  if (process.env.SHOT) await w.page.screenshot({ path: process.env.SHOT })
  await dialog.getByRole("button", { name: "Stop job1" }).click(); await w.page.waitForTimeout(1500)
  const after = await dialog.innerText()
  check("Stop stops it, and the list says so", /job1 · stopped/.test(after) && /None running now/.test(after) && !(await dialog.getByRole("button", { name: "Stop job1" }).count()), after.replace(/\n+/g, " | ").slice(0, 200))
  for (let i = 0; i < 40 && alive(pid); i++) await w.page.waitForTimeout(100)
  check("the process is gone", !alive(pid))
  await dialog.getByRole("button", { name: "Close" }).click(); await w.page.waitForTimeout(300)
  check("the chip is gone again", !(await chip.isVisible()))
  check("no console errors", w.errors.length === 0, w.errors.join(" | "))
} catch (error) { check("web jobs pass", false, error.message) } finally { await w.close(); for (const pid of pids()) { try { process.kill(pid) } catch {} } }
model.close()
console.log(failed() ? `\n${failed()} failed` : "\nall passed")
process.exit(0)
