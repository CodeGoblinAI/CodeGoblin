// User pass, terminal: seeing what a command is doing, and not being stuck behind one.
// 1. While a command runs, its row shows how long it has run and the last lines it printed.
// 2. Finished, the row is short; a click opens it to the whole command and all of its output, a click folds it.
// 3. A command that outlives its wait is not killed and does not hold the turn: the model is told it carries
//    on as a background job, and the status bar shows a job running.
// 4. While the goblin works: "/" still lists commands, /jobs opens at once, and two things typed are both
//    queued and sent in order.
import fs from "node:fs"
import path from "node:path"
import { check, failed, fakeModel, tempDir, tui, delay, plain } from "./harness.mjs"

const LONG = "bun slow.js --label=a-very-long-argument-that-goes-well-past-sixty-characters-in-total"
const model = await fakeModel(async (sent) => {
  const last = sent.messages.at(-1)
  const text = String(last?.content ?? "")
  if (last?.role === "tool") return { text: "done with that" }
  if (/watch/.test(text)) return { tool: "shell", args: { command: LONG } }
  if (/forever/.test(text)) return { tool: "shell", args: { command: "bun forever.js", timeout_ms: 2500 } }
  if (/slow/.test(text)) { await delay(9000); return { text: "slow answer" } }
  return { text: "answer to " + text.slice(0, 40) }
})
const project = tempDir("cg-watch-project-")
fs.writeFileSync(path.join(project, "slow.js"), "let n = 0; const t = setInterval(() => { console.log('step ' + ++n + ' of 14'); if (n === 14) { clearInterval(t) } }, 450)")
fs.writeFileSync(path.join(project, "forever.js"), "let n = 0; setInterval(() => console.log('file ' + ++n + ' of 3000000000'), 300)")

const t = await tui({ model, cwd: project, cols: 120, rows: 40 })
const screen = () => plain(t.out.split("\x1b[2J").at(-1)).replace(/\r/g, "")
const waitFor = async (pattern, ms = 15000) => { for (let waited = 0; waited < ms; waited += 150) { if (pattern.test(screen())) return true; await delay(150) } return false }
const find = (text) => { const rows = screen().split("\n"); const row = rows.findIndex((line) => line.includes(text)); return row < 0 ? undefined : { row: row + 1, col: rows[row].indexOf(text) + 1 } }
const click = async (at) => { t.write(`\x1b[<0;${at.col + 2};${at.row}M`); await delay(60); t.write(`\x1b[<0;${at.col + 2};${at.row}m`); await delay(500) }
const sentToModel = () => model.seen.map((body) => body.messages.at(-1))

try {
  await waitFor(/ask · /)
  // Full access, so nothing waits on an approval here; approvals have their own passes.
  t.write("[Z"); await delay(300); t.write("[Z"); await delay(300)
  // --- 1. watching it run ---
  t.write("watch this\r")
  check("while it runs, the row shows what the command is printing", await waitFor(/… shell bun slow\.js[^\n]*\n\s+│ step \d+ of 14/), screen().split("\n").filter((l) => /shell|step/.test(l)).join("\n"))
  check("and, after a few seconds, for how long it has run", await waitFor(/… shell bun slow\.js[^\n]*· [3-9]s/, 9000), screen().split("\n").filter((l) => /shell/.test(l)).join("\n"))
  const during = screen().split("\n").filter((line) => /│ step/.test(line)).length
  check("only its last few lines, not the whole of it", during > 0 && during <= 5, String(during))
  check("it finishes and the answer comes", await waitFor(/done with that/, 15000))

  // --- 2. open and fold ---
  check("finished, the row is cut short and says there is more", /✓ shell bun slow\.js --label=a-very-long-argument-that-goes-well-past\s*$/m.test(screen()) && /… \+10 lines \(click, or ctrl\+o to expand\)/.test(screen()), screen().split("\n").filter((l) => /shell|lines/.test(l)).join("\n"))
  await click(find("✓ shell bun slow.js"))
  const opened = screen()
  check("a click opens it: the whole command", opened.includes(LONG), opened.split("\n").filter((l) => /shell/.test(l)).join("\n"))
  check("and all of its output", /step 14 of 14/.test(opened) && /step 1 of 14/.test(opened) && /click to fold/.test(opened))
  await click(find("✓ shell bun slow.js"))
  check("another click folds it again", !/step 14 of 14/.test(screen()) && /… \+10 lines \(click, or ctrl\+o to expand\)/.test(screen()))
  t.write("\x0f"); await delay(500)
  check("ctrl+o opens every command without the mouse", screen().includes(LONG) && /step 14 of 14/.test(screen()), screen().split("\n").filter((l) => /shell|step|ctrl/.test(l)).join("\n"))
  t.write("\x0f"); await delay(500)
  check("and ctrl+o again folds it", !/step 14 of 14/.test(screen()) && /… \+10 lines \(click, or ctrl\+o to expand\)/.test(screen()))

  // --- 3. a command that outlives its wait ---
  const before = model.seen.length
  t.write("run forever\r")
  check("the turn is not held: the answer comes soon after the wait is over", await waitFor(/done with that[\s\S]*done with that/, 12000))
  const told = String(sentToModel().slice(before).find((message) => message?.role === "tool")?.content ?? "")
  check("the model is told it is still running, as a job it can read or stop", /still running after 3s\. It was not stopped: it carries on in the background as job1/.test(told) && /job_stop ends it/.test(told), told.slice(-400))
  check("and is shown what it had printed, which says how big the job is", /file \d+ of 3000000000/.test(told))
  check("the row says so too, and is not marked as failed", /✓ shell bun forever\.js\s+->\s+still running after 3s - carries on as job1 \(\/jobs\)/.test(screen()), screen().split("\n").filter((l) => /forever|still running/.test(l)).join("\n"))
  check("the status bar shows a job running", /\[1 job running\]/.test(screen()), screen().split("\n").slice(-4).join("\n"))

  // --- 4. slash commands while it works ---
  t.write("slow one\r"); await delay(1200)
  t.write("/"); await delay(500)
  check("typing / while it works lists the commands", await waitFor(/1 of \d+/, 4000) && /show these commands|start a fresh conversation|switch provider/.test(screen()), screen().split("\n").slice(-16).join("\n"))
  for (const char of "jobs") { t.write(char); await delay(50) }
  t.write("\r")
  check("/jobs opens at once, not when the turn ends", await waitFor(/Background jobs[\s\S]*job1/, 3000), screen().split("\n").slice(0, 12).join("\n"))
  t.write("\x1b"); await delay(300)
  for (const char of "first thing") { t.write(char); await delay(20) } t.write("\r"); await delay(300)
  for (const char of "second thing") { t.write(char); await delay(20) } t.write("\r"); await delay(400)
  check("two messages typed while it works are both kept", /first thing/.test(screen()) && /\+ 1 more after it/.test(screen()) && /queued behind 1 other/.test(screen()), screen().split("\n").filter((l) => /queued|first|more after/.test(l)).join("\n"))
  check("and both are sent, in order, once it finishes", await waitFor(/answer to first thing[\s\S]*answer to second thing/, 25000), screen().split("\n").filter((l) => /answer to/.test(l)).join("\n"))
  const order = sentToModel().filter((message) => message?.role === "user").map((message) => String(message.content)).filter((text) => /thing/.test(text))
  check("the model got them in the order they were typed", /first thing/.test(order[0] ?? "") && /second thing/.test(order.at(-1) ?? ""), JSON.stringify(order))
} catch (error) { check("watch pass", false, error.message + "\n" + screen().slice(-800)) } finally { t.write("\x03"); await delay(300); t.kill() }
model.close()
process.stdout.write((failed() ? `\n${failed()} failed` : "\nall passed") + "\n", () => process.kill(process.pid, "SIGKILL"))
