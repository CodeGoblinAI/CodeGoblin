// User pass, terminal: everyday things that were wrong or missing.
// 1. Esc while an answer runs stops the answer and leaves what you have typed alone.
// 2. Dragging over text in the prompt box copies it, as dragging over an answer does.
// 3. A plan with every step done leaves the screen when its answer ends; an unfinished one stays.
// 4. A command being waited on can be sent to the background (ctrl+b, or a click), the answer goes on,
//    the jobs button opens the list, and when the job ends by itself the model is told without being asked.
import { execFileSync } from "node:child_process"
import { check, failed, fakeModel, tempDir, tui, delay, plain } from "./harness.mjs"

const windows = process.platform === "win32"
const SLOW = windows ? "ping -n 9 127.0.0.1 > nul & echo build finished" : "sleep 8; echo build finished"
const seen = []
const model = await fakeModel(async (sent) => {
  const last = sent.messages.at(-1)
  const said = String(sent.messages.filter((m) => m.role === "user").at(-1)?.content ?? "")
  seen.push({ role: last?.role, content: String(last?.content ?? "").slice(0, 600) })
  if (last?.role === "tool") return { text: /sent to the background/.test(String(last.content)) ? "It is running in the background; carrying on." : "Plan recorded." }
  if (/background job/i.test(said) && /has ended/.test(said)) return { text: "Noted: the build finished." }
  if (/slow answer/.test(said)) { await delay(7000); return { text: "the slow answer" } }
  if (/all done plan/.test(said)) return { tool: "todo_write", args: { todos: [{ content: "read the code", status: "completed" }, { content: "write the fix", status: "completed" }] } }
  if (/open plan/.test(said)) return { tool: "todo_write", args: { todos: [{ content: "read the code", status: "completed" }, { content: "write the fix", status: "pending" }] } }
  if (/build it/.test(said)) return { tool: "shell", args: { command: SLOW } }
  return { text: "ok" }
})
const screenOf = (t) => plain(t.out.split("\x1b[2J").at(-1)).replace(/\r/g, "")
const boxOf = (t) => screenOf(t).split("\n").filter((line) => /^\s*\| /.test(line)).at(-1) ?? ""
const waitFor = async (t, pattern, ms = 15000) => { for (let waited = 0; waited < ms; waited += 150) { if (pattern.test(screenOf(t))) return true; await delay(150) } return false }
const type = async (t, text) => { for (const char of text) { t.write(char); await delay(25) } }
const find = (t, text) => { const rows = screenOf(t).split("\n"); const row = rows.findLastIndex((line) => line.includes(text)); return row < 0 ? undefined : { row: row + 1, col: rows[row].indexOf(text) + 1 } }
const mouse = (t, kind, col, row) => t.write(`\x1b[<${kind === "drag" ? 32 : 0};${col};${row}${kind === "up" ? "m" : "M"}`)
const clipboard = () => (windows ? execFileSync("powershell.exe", ["-NoProfile", "-Command", "Get-Clipboard -Raw"], { encoding: "utf8" }).replace(/\r/g, "").trimEnd() : "")
const setClipboard = (text) => { if (windows) execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Set-Clipboard -Value ([Console]::In.ReadToEnd())"], { input: text }) }
const keep = clipboard()

const t = await tui({ model, cwd: tempDir("cg-everyday-"), cols: 150, rows: 40, extraEnv: { CODEGOBLIN_LOCAL_TOOLS: "1" } })
try {
  // Full access, so the shell command below is not a question.
  await waitFor(t, /ask · /)
  t.write("\x1b[Z"); await delay(300); t.write("\x1b[Z"); await delay(400)

  // --- 1. Esc and the draft ---
  await type(t, "slow answer please"); t.write("\r"); await waitFor(t, /esc twice stops|enter queue/, 5000)
  await type(t, "the correction I was writing"); await delay(200)
  t.write("\x1b"); await delay(400)
  // Read by waiting: a frame caught half drawn has no box in it.
  check("Esc while an answer runs arms the stop", await waitFor(t, /press esc again to stop/, 2500), screenOf(t).split("\n").filter((l) => /esc/.test(l)).slice(-2).join(" | "))
  check("and leaves what is typed in the box", await waitFor(t, /\| the correction I was writing/, 2500), boxOf(t))
  t.write("\x1b"); await delay(1500)
  check("a second Esc stops the answer, and the draft is still there", /stopped/.test(screenOf(t)) && /the correction I was writing/.test(boxOf(t)) && !/the slow answer/.test(screenOf(t)), boxOf(t))
  t.write("\x1b"); await delay(300)
  check("with nothing running, Esc clears the box as before", !/the correction/.test(boxOf(t)), boxOf(t))

  // --- 2. selecting in the prompt box copies ---
  if (windows) {
    await type(t, "some words of my own to copy"); await delay(300)
    const at = find(t, "words of my own")
    setClipboard("nothing-yet")
    mouse(t, "down", at.col, at.row); await delay(80)
    for (let col = at.col + 3; col < at.col + 15; col += 4) { mouse(t, "drag", col, at.row); await delay(30) }
    // The box selects between characters, as an editor does: to take the last letter the mouse passes it.
    mouse(t, "drag", at.col + 15, at.row); await delay(200); mouse(t, "up", at.col + 15, at.row)
    check("letting go after a drag in the prompt box says it copied", await waitFor(t, /copied 15 chars to clipboard/, 4000), screenOf(t).split("\n").filter((l) => /copied/.test(l)).join(" | "))
    check("and the words are on the clipboard", clipboard() === "words of my own", JSON.stringify(clipboard()))
    check("the words are still in the box", /some words of my own to copy/.test(boxOf(t)))
    t.write("\x15"); await delay(300)
  }

  // --- 3. the plan ---
  await type(t, "open plan"); t.write("\r"); await waitFor(t, /Plan recorded/, 10000); await delay(1200)
  check("an unfinished plan stays on screen after its answer", /plan 1\/2/.test(screenOf(t)), screenOf(t).split("\n").filter((l) => /plan/.test(l)).join(" | "))
  await type(t, "all done plan"); t.write("\r"); await delay(600)
  await waitFor(t, /Plan recorded[\s\S]*Plan recorded/, 10000); await delay(1500)
  check("a plan with every step done is shown while its answer runs, then leaves", /plan 2\/2/.test(plain(t.out)) && !/plan \d\/\d/.test(screenOf(t)), screenOf(t).split("\n").filter((l) => /plan \d/.test(l)).join(" | ") || "(no plan on screen)")

  // --- 4. a command being waited on ---
  await type(t, "build it"); t.write("\r")
  check("the command being waited on is named at the bottom, with how to stop waiting", await waitFor(t, /\[Waiting on a command \d+s · ctrl\+b backgrounds it\]/, 8000), screenOf(t).split("\n").slice(-3).join("\n"))
  const sentAt = Date.now()
  t.write("\x02")
  check("ctrl+b ends the wait: the answer carries on at once", await waitFor(t, /carrying on/, 6000) && Date.now() - sentAt < 6000, `${Date.now() - sentAt} ms`)
  check("the model was told it was sent to the background, and that it is still running", seen.some((each) => each.role === "tool" && /sent to the background by the user/.test(each.content) && /carries on in the background as job1/.test(each.content)), JSON.stringify(seen.filter((each) => each.role === "tool").at(-1)))
  const jobs = find(t, "[Jobs: 1 running]")
  check("the bottom row has a jobs button", Boolean(jobs), screenOf(t).split("\n").slice(-3).join("\n"))
  if (jobs) {
    mouse(t, "down", jobs.col + 3, jobs.row); await delay(60); mouse(t, "up", jobs.col + 3, jobs.row)
    check("clicking it opens the list: the command, and how long it has run", await waitFor(t, /Background jobs[\s\S]*job1[\s\S]*running \d+s/, 4000), screenOf(t).split("\n").filter((l) => /job1|Background/.test(l)).join(" | "))
    t.write("\x1b"); await delay(400)
  }
  check("when the job ends by itself the model is told, without anyone asking", await waitFor(t, /Noted: the build finished/, 20000), screenOf(t).split("\n").slice(-12).join("\n"))
  check("what it was told names the job and how it ended", seen.some((each) => each.role === "user" && /background job1/.test(each.content) && /finished, exit code 0/.test(each.content)), JSON.stringify(seen.filter((each) => each.role === "user").at(-1)))
  check("the jobs button is gone again", !/\[Jobs: /.test(screenOf(t)))
} catch (error) { check("pass", false, error.message + "\n" + screenOf(t).slice(-700)) } finally { t.kill(); if (keep) setClipboard(keep) }
model.close()
console.log(failed() ? `\n${failed()} failed` : "\nall passed")
if (windows) process.kill(process.pid)
process.exit(failed() ? 1 : 0)
