// User pass: a question about a tool call that arrives while a follow-up is being typed. It was never drawn -
// the box only showed over an empty prompt - so the turn waited, unseen, until the prompt happened to be
// emptied. Now the draft is put aside and given back, and typing straight on into the question cannot answer it.
import { check, failed, fakeModel, tempDir, tui, delay, plain } from "./harness.mjs"

let ran = false
const model = await fakeModel(async (sent) => {
  const tool = sent.messages.filter((m) => m.role === "tool").at(-1)
  if (!tool) { await delay(1500); return { tool: "shell", args: { command: "npm publish --dry-run" } } }
  ran = !/refused/.test(String(tool.content))
  return { text: "turn finished" }
})
const t = await tui({ model, cwd: tempDir("cg-approve-typing-"), cols: 120, rows: 36 })
const frame = () => plain(t.out.split("\x1b[2J").at(-1)).replace(/\r/g, "")
const box = () => frame().split("\n").filter((line) => /^\s*\| /.test(line)).at(-1) ?? ""
try {
  await delay(1200)
  t.write("go\r"); await delay(200)
  for (const char of "a follow up I am writing") { t.write(char); await delay(20) }
  // Typing straight on as the question appears, Enter included.
  let shown = false
  for (let waited = 0; waited < 5000 && !shown; waited += 40) { await delay(40); shown = /allow shell/.test(frame()) }
  t.write(" more"); t.write("\r")
  await delay(400)
  check("the question is drawn although a follow-up was being typed", shown && /allow shell/.test(frame()), frame().split("\n").slice(-12).join("\n"))
  check("the Enter typed as it appeared answered nothing: the command did not run, the question is still there", !ran && /allow shell/.test(frame()) && !/turn finished/.test(frame()))
  await delay(500)
  t.write("\x1b[B\x1b[B\r") // Reject
  await t.until((s) => /turn finished/.test(s), 10000, "turn end")
  await delay(400)
  check("answered, the turn goes on", /turn finished/.test(frame()) && !ran)
  check("and the draft is back in the box, with what was typed into the question's first moment", /a follow up I am writing more/.test(box()), box())
} catch (error) { check("pass", false, error.message + "\n" + frame().slice(-600)) } finally { t.kill() }
model.close()
console.log(failed() ? `\n${failed()} failed` : "\nall passed")
if (process.platform === "win32") process.kill(process.pid)
process.exit(failed() ? 1 : 0)
