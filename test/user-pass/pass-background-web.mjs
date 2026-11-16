// User pass, web app: a command the answer is waiting on. After a few seconds its row offers "run in
// background"; clicking it ends the wait, the answer carries on, the job shows under the prompt, and when it
// ends by itself the model is told without anyone asking.
import { check, failed, fakeModel, tempDir, web } from "./harness.mjs"

const windows = process.platform === "win32"
const SLOW = windows ? "ping -n 12 127.0.0.1 > nul & echo build finished" : "sleep 11; echo build finished"
const seen = []
const model = await fakeModel(async (sent) => {
  const last = sent.messages.at(-1)
  const said = String(sent.messages.filter((m) => m.role === "user").at(-1)?.content ?? "")
  seen.push({ role: last?.role, content: String(last?.content ?? "").slice(0, 500) })
  if (last?.role === "tool") return { text: /sent to the background/.test(String(last.content)) ? "It is running in the background; carrying on." : "The build finished while I waited." }
  if (/background job/i.test(said) && /has ended/.test(said)) return { text: "Noted: the build finished." }
  return { tool: "shell", args: { command: SLOW } }
})
const w = await web({ model, cwd: tempDir("cg-bgweb-project-") })
const thread = () => w.page.locator(".thread").innerText()
try {
  await w.box.fill("build it"); await w.page.keyboard.press("Enter")
  const prompt = w.page.locator(".permission").last()
  await prompt.waitFor({ timeout: 10000 })
  await prompt.getByRole("button", { name: "Allow once" }).click()
  const later = w.page.locator(".tool.running .tbg")
  check("nothing offers to background a command in its first seconds", !(await later.isVisible().catch(() => false)))
  await later.waitFor({ timeout: 8000 }).catch(() => {})
  check("after a few seconds the running command offers to run in the background", await later.isVisible().catch(() => false), (await thread()).slice(-200))
  const at = Date.now()
  await later.click()
  await w.page.waitForFunction(() => /carrying on/.test(document.querySelector(".thread")?.textContent ?? ""), null, { timeout: 8000 }).catch(() => {})
  check("clicking it ends the wait: the answer carries on at once", /carrying on/.test(await thread()) && Date.now() - at < 8000, `${Date.now() - at} ms`)
  check("the model was told it was sent to the background and is still running", seen.some((each) => each.role === "tool" && /sent to the background by the user/.test(each.content) && /carries on in the background as job1/.test(each.content)), JSON.stringify(seen.at(-1)))
  const chip = w.page.locator("#jobs-chip")
  await w.page.waitForTimeout(1200)
  check("the job shows under the prompt", (await chip.isVisible()) && /1 job running/.test(await chip.innerText()), await chip.innerText().catch(() => "hidden"))
  check("the finished row no longer offers it", !(await w.page.locator(".tbg").first().isVisible().catch(() => false)))
  await w.page.waitForFunction(() => /Noted: the build finished/.test(document.querySelector(".thread")?.textContent ?? ""), null, { timeout: 30000 }).catch(() => {})
  check("when the job ends by itself the model is told, without anyone asking", /Noted: the build finished/.test(await thread()), (await thread()).slice(-300))
  check("what it was told names the job and how it ended", seen.some((each) => each.role === "user" && /background job1/.test(each.content) && /finished, exit code 0/.test(each.content)), JSON.stringify(seen.filter((each) => each.role === "user").at(-1)))
  await w.page.waitForTimeout(800)
  check("the chip is gone again", !(await chip.isVisible()))
  check("no console errors", w.errors.length === 0, w.errors.join(" | "))
} catch (error) { check("pass", false, error.message) } finally { await w.close() }
model.close()
console.log(failed() ? `\n${failed()} failed` : "\nall passed")
process.exit(failed() ? 1 : 0)
