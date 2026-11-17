// User pass: the terminal window is closed part way through a turn. A conversation used to be saved only
// when a turn ended, so the prompt and every finished step were lost - while the files the steps had changed
// stayed changed, with no record of what was done. Now the turn is saved as it goes.
import fs from "node:fs"
import path from "node:path"
import { check, failed, fakeModel, tempDir, tui, delay } from "./harness.mjs"

const model = await fakeModel(async (sent) => {
  const tools = sent.messages.filter((m) => m.role === "tool").length
  if (tools === 0) return { tool: "write_file", args: { path: "made-by-step-one.txt", content: "step one was here" } }
  await delay(30000) // the next step never comes back before the window is closed
  return { text: "too late" }
})
const profile = tempDir("cg-killed-profile-")
const project = tempDir("cg-killed-project-")
const t = await tui({ model, cwd: project, profile, cols: 120, rows: 36 })
try {
  await delay(1000)
  t.write("\x1b[Z"); await delay(300); t.write("\x1b[Z"); await delay(300) // full access: nothing is asked
  t.write("make the file, then think for a long time\r")
  await t.until(() => fs.existsSync(path.join(project, "made-by-step-one.txt")), 10000, "step one")
  await delay(2500)
} finally { t.kill() }
await delay(500)
const store = path.join(profile, "state", "sessions")
const saved = fs.existsSync(store) ? fs.readdirSync(store).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(fs.readFileSync(path.join(store, f), "utf8"))) : []
const messages = saved[0]?.messages ?? []
check("closed part way through a turn, the prompt is on disk", messages.some((m) => m.role === "user" && /make the file/.test(m.content)), JSON.stringify(messages.map((m) => m.role)))
check("and so is the step it finished: the call and what it did", messages.some((m) => m.role === "assistant" && m.tool_calls?.some((c) => c.function.name === "write_file")) && messages.some((m) => m.role === "tool" && /made-by-step-one/.test(m.content)), JSON.stringify(messages.map((m) => m.role + (m.tool_calls ? "(calls)" : ""))))
model.close()
console.log(failed() ? `\n${failed()} failed` : "\nall passed")
if (process.platform === "win32") process.kill(process.pid)
process.exit(failed() ? 1 : 0)
