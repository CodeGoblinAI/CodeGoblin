// User pass, web app: seeing what a command is doing, and not being stuck behind one.
// 1. While a command runs, its row says for how long and shows the last lines it printed.
// 2. Finished, the row is one line; a click opens it to the whole command and all of its output, a click folds it.
// 3. A command that outlives its wait is handed back as a background job: the row says so and the jobs chip shows.
// 4. While the goblin works, /jobs opens at once, and two messages typed are both kept and sent in order.
import fs from "node:fs"
import path from "node:path"
import { check, failed, fakeModel, tempDir, web, delay } from "./harness.mjs"

const LONG = "bun slow.js --label=a-very-long-argument-that-goes-well-past-seventy-characters-in-total-for-sure"
const model = await fakeModel(async (sent) => {
  const last = sent.messages.at(-1)
  const text = String(last?.content ?? "")
  if (last?.role === "tool") return { text: "done with that" }
  if (/watch/.test(text)) return { tool: "shell", args: { command: LONG } }
  if (/forever/.test(text)) return { tool: "shell", args: { command: "bun forever.js", timeout_ms: 2500 } }
  if (/slow/.test(text)) { await delay(7000); return { text: "slow answer" } }
  return { text: "answer to " + text.slice(0, 40) }
})
const project = tempDir("cg-watchweb-project-")
fs.writeFileSync(path.join(project, "slow.js"), "let n = 0; const t = setInterval(() => { console.log('step ' + ++n + ' of 14'); if (n === 14) { clearInterval(t) } }, 450)")
fs.writeFileSync(path.join(project, "forever.js"), "require('fs').appendFileSync('pids.txt', process.pid + '\\n'); let n = 0; setInterval(() => console.log('file ' + ++n + ' of 3000000000'), 300)")
const pids = () => fs.existsSync(path.join(project, "pids.txt")) ? fs.readFileSync(path.join(project, "pids.txt"), "utf8").trim().split("\n").map(Number) : []

const w = await web({ model, cwd: project })
const page = w.page
const threadText = () => page.locator(".thread").innerText()
const waitText = (pattern, ms = 15000) => page.waitForFunction((source) => new RegExp(source).test(document.querySelector(".thread")?.textContent ?? ""), pattern.source, { timeout: ms }).then(() => true).catch(() => false)
const allow = async () => { const prompt = page.locator(".permission").last(); await prompt.waitFor({ timeout: 10000 }); await prompt.getByRole("button", { name: "Allow once" }).click() }
const sentToModel = () => model.seen.map((body) => body.messages.at(-1))

try {
  // --- 1. watching it run ---
  await w.box.fill("watch this"); await page.keyboard.press("Enter")
  await allow()
  const live = page.locator("pre.tool-out.live")
  await live.waitFor({ timeout: 8000 }).catch(() => {})
  check("while it runs, what the command prints shows under its row", /step \d+ of 14/.test(await live.innerText().catch(() => "")), await threadText())
  await page.waitForFunction(() => /· [3-9]s/.test(document.querySelector(".tool.running .tage")?.textContent ?? ""), null, { timeout: 9000 }).catch(() => {})
  check("and, after a few seconds, for how long it has run", /· [3-9]s/.test(await page.locator(".tool.running .tage").innerText().catch(() => "")))
  const during = (await live.innerText().catch(() => "")).split("\n").filter(Boolean).length
  check("only its last few lines, not the whole of it", during > 0 && during <= 5, String(during))
  check("it finishes and the answer comes", await waitText(/done with that/))

  // --- 2. open and fold ---
  const row = page.locator(".tool.openable").first()
  check("finished, the row is one line and says how much there is", (await page.locator("pre.tool-out").count()) === 0 && /· 14 lines/.test(await row.innerText()), await row.innerText().catch(() => "no row"))
  await row.click(); await page.waitForTimeout(300)
  const opened = await page.locator("pre.tool-out").innerText().catch(() => "")
  check("a click opens it: the whole command", opened.includes("$ " + LONG), opened.slice(0, 200))
  check("and all of its output", /step 1 of 14/.test(opened) && /step 14 of 14/.test(opened))
  if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT })
  await row.click(); await page.waitForTimeout(300)
  check("another click folds it again", (await page.locator("pre.tool-out").count()) === 0)
  await row.focus(); await page.keyboard.press("Enter"); await page.waitForTimeout(300)
  check("Enter on the row opens it too", (await page.locator("pre.tool-out").count()) === 1)
  await page.keyboard.press("Enter"); await page.waitForTimeout(300)

  // --- 3. a command that outlives its wait ---
  const before = model.seen.length
  await w.box.fill("run forever"); await page.keyboard.press("Enter")
  await allow()
  check("the turn is not held: the answer comes soon after the wait is over", await waitText(/done with that[\s\S]*done with that/, 14000))
  const told = String(sentToModel().slice(before).find((message) => message?.role === "tool")?.content ?? "")
  check("the model is told it is still running, as a job it can read or stop", /still running after 3s\. It was not stopped: it carries on in the background as job1/.test(told), told.slice(-300))
  const second = page.locator(".tool.openable").nth(1)
  check("the row says so too, and is not marked as failed", /still running after 3s - carries on as job1/.test(await second.innerText()) && !(await second.evaluate((el) => el.classList.contains("failed"))), await second.innerText().catch(() => ""))
  await page.waitForTimeout(700)
  check("the jobs chip shows a job running", /^1 job running$/.test((await page.locator("#jobs-chip").innerText().catch(() => "")).trim()))

  // --- 4. while it works ---
  await w.box.fill("slow one"); await page.keyboard.press("Enter"); await page.waitForTimeout(900)
  await w.box.fill("/jobs"); await page.keyboard.press("Enter")
  await page.locator("dialog.jobs").getByText("job1").first().waitFor({ timeout: 3000 }).catch(() => {})
  const listed = await page.locator("dialog.jobs").innerText().catch(() => "")
  check("/jobs opens at once, not when the turn ends", /job1/.test(listed) && !/slow answer/.test(await threadText()), listed.slice(0, 200))
  await page.locator("dialog.jobs").getByRole("button", { name: "Close" }).click({ timeout: 2000 }).catch(() => {}); await page.waitForTimeout(300)
  await w.box.fill("first thing"); await page.keyboard.press("Enter"); await page.waitForTimeout(250)
  await w.box.fill("second thing"); await page.keyboard.press("Enter"); await page.waitForTimeout(300)
  const notes = await threadText()
  check("two messages typed while it works are both kept", /Queued until this turn finishes: first thing/.test(notes) && /Queued behind 1 other: second thing/.test(notes), notes.slice(-400))
  check("and both are answered, in order, once it finishes", await waitText(/answer to first thing[\s\S]*answer to second thing/, 25000), (await threadText()).slice(-400))
  const order = sentToModel().filter((message) => message?.role === "user").map((message) => String(message.content)).filter((text) => /thing/.test(text))
  check("the model got them in the order they were typed", /first thing/.test(order[0] ?? "") && /second thing/.test(order.at(-1) ?? "") && order.length === 2, JSON.stringify(order))
  check("no console errors", w.errors.length === 0, w.errors.join(" | "))
} catch (error) { check("web watch pass", false, error.message) } finally { await w.close(); for (const pid of pids()) { try { process.kill(pid) } catch {} } }
model.close()
console.log(failed() ? `\n${failed()} failed` : "\nall passed")
process.exit(0)
