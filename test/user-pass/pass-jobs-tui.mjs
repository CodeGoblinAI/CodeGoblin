// User pass, terminal: background jobs. The model starts a dev server in the background and waits for its
// ready line; the status bar says a job is running; /jobs lists it, shows its output and stops it; quitting
// ends whatever is still running. The server is a real process, checked by its pid.
import fs from "node:fs"
import path from "node:path"
import { check, failed, fakeModel, tempDir, tui, delay, plain } from "./harness.mjs"

const project = tempDir("cg-jobs-project-")
fs.writeFileSync(path.join(project, "server.js"), "require('fs').appendFileSync('pids.txt', process.pid + '\\n'); console.log('starting'); setTimeout(() => console.log('Ready on http://localhost:4000'), 2500); let n = 0; setInterval(() => console.log('tick ' + ++n), 500)")
const pids = () => fs.existsSync(path.join(project, "pids.txt")) ? fs.readFileSync(path.join(project, "pids.txt"), "utf8").trim().split("\n").map(Number) : []
const alive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }
const gone = async (pid) => { for (let i = 0; i < 50 && alive(pid); i++) await delay(100); return !alive(pid) }

const model = await fakeModel(async (sent) => {
  const last = sent.messages.at(-1); const text = String(last?.content ?? "")
  if (last?.role === "tool" && /started job\d+ in the background/.test(text)) return { tool: "job_output", args: { id: /started (job\d+)/.exec(text)[1], until: "ready on" } }
  if (last?.role === "tool") return { text: "The server is up on port 4000." }
  return { tool: "shell", args: { command: "bun server.js", background: true } }
})
const screenOf = (t) => plain(t.out.split("\x1b[2J").at(-1)).replace(/\r/g, "")
const waitFor = async (t, pattern, ms = 15000) => { for (let waited = 0; waited < ms; waited += 200) { if (pattern.test(screenOf(t))) return true; await delay(200) } return false }
const show = (label, t) => { if (process.env.SHOW) console.log(`\n===== ${label} =====\n` + screenOf(t).split("\n").map((line) => line.trimEnd()).join("\n")) }

const t = await tui({ model, cwd: project, cols: 120, rows: 36 })
try {
  await waitFor(t, /ask · /)
  t.write("/jobs\r"); await delay(700)
  check("/jobs with nothing running says what jobs are", /No background jobs/.test(screenOf(t)) && /dev server/.test(screenOf(t)), screenOf(t).split("\n").filter((l) => /│/.test(l)).join("\n"))
  t.write("\x1b"); await delay(300)

  t.write("start the server\r")
  check("the approval says the command will keep running", await waitFor(t, /bun server\.js\s+\(kept running in the background\)/) && /Allow once/.test(screenOf(t)), screenOf(t).split("\n").filter((l) => /server|Allow/.test(l)).join(" | "))
  show("approval", t)
  t.write("\r")
  check("the answer arrives once the server says it is ready", await waitFor(t, /The server is up on port 4000/, 20000))
  show("answer", t)
  const page = screenOf(t)
  check("the start row says a job began, with what it printed", /started job1/.test(page) && /starting/.test(page), page.split("\n").filter((l) => /job1|starting/.test(l)).join(" | "))
  check("the wait row shows the ready line", /"ready on" is in its output/.test(page) && /Ready on http:\/\/localhost:4000/.test(page), page.split("\n").filter((l) => /ready/i.test(l)).join(" | "))
  check("the status bar says a job is running", /\[1 job running\]/.test(page), page.split("\n").slice(-3).join(" | "))
  const first = pids()[0]
  check("the server is a real process, still running after the turn", first > 0 && alive(first), String(first))

  t.write("/jobs\r"); await delay(800); show("/jobs", t)
  const list = screenOf(t)
  check("/jobs lists it with how long it has run, and a row to stop it", /job1\s+bun server\.js/.test(list) && /running \d+s · enter shows its output/.test(list) && /Stop job1/.test(list), list.split("\n").filter((l) => /│/.test(l)).join("\n"))
  t.write("\r"); await delay(700); show("output", t)
  check("enter puts its last output in the conversation", /job1 · bun server\.js/.test(screenOf(t)) && /tick \d+/.test(screenOf(t)), screenOf(t).split("\n").filter((l) => /tick|job1/.test(l)).slice(0, 4).join(" | "))
  check("showing it to the person did not call the model", model.seen.length === 3, String(model.seen.length))

  t.write("/jobs\r"); await delay(700); t.write("\x1b[B"); await delay(200); t.write("\r"); await delay(1500); show("stopped", t)
  const after = screenOf(t)
  check("the stop row stops it, and the list says so", /job1\s+bun server\.js/.test(after) && /stopped · enter shows its output/.test(after) && !/Stop job1/.test(after), after.split("\n").filter((l) => /│/.test(l)).join("\n"))
  check("the process is gone", await gone(first))
  t.write("\x1b"); await delay(400)
  check("the status bar no longer says a job is running", !/job running\]/.test(screenOf(t)), screenOf(t).split("\n").slice(-3).join(" | "))

  // Quitting ends what is still running.
  t.write("start it again\r"); await waitFor(t, /Allow once/); t.write("\r")
  await waitFor(t, /\[1 job running\]/, 20000); await delay(500)
  const second = pids()[1]
  check("a second job runs", second > 0 && alive(second), String(second))
  t.write("/quit\r")
  check("quitting ends the job with the app", await gone(second))
} catch (error) { check("jobs pass", false, error.message) } finally { t.kill(); for (const pid of pids()) { try { process.kill(pid) } catch {} } }
model.close()
console.log(failed() ? `\n${failed()} failed` : "\nall passed")
process.exit(0)
