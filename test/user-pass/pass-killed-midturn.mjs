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

// --- the same with the web server ended outright part way through ---
{
  const { web } = await import("./harness.mjs")
  const webProfile = tempDir("cg-killed-web-profile-")
  const webProject = tempDir("cg-killed-web-project-")
  const w = await web({ model, cwd: webProject, profile: webProfile })
  try {
    await w.send("/model local/fixture")
    await w.page.evaluate(() => { const mode = document.querySelector("#mode"); if (mode) mode.value = "full" })
    await w.send("make the file, then think for a long time", 200)
    for (let waited = 0; waited < 15000 && !fs.existsSync(path.join(webProject, "made-by-step-one.txt")); waited += 200) {
      // The web asks before a write unless told otherwise; allow it once.
      const allow = w.page.getByRole("button", { name: "Allow once" })
      if (await allow.count()) await allow.first().click().catch(() => {})
      await delay(200)
    }
    await delay(2500)
  } finally {
    w.server.kill("SIGKILL")
    await w.close()
  }
  await delay(500)
  const webStore = path.join(webProfile, "state", "sessions")
  const webSaved = fs.existsSync(webStore) ? fs.readdirSync(webStore).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(fs.readFileSync(path.join(webStore, f), "utf8"))) : []
  const webMessages = webSaved.find((s) => s.messages.some((m) => m.role === "user" && /make the file/.test(m.content)))?.messages ?? []
  check("web: the server ended part way through a turn, the prompt and the finished step are on disk", webMessages.some((m) => m.role === "tool" && /made-by-step-one/.test(m.content)), JSON.stringify(webMessages.map((m) => m.role + (m.tool_calls ? "(calls)" : ""))))
}
model.close()
console.log(failed() ? `\n${failed()} failed` : "\nall passed")
if (process.platform === "win32") process.kill(process.pid)
process.exit(failed() ? 1 : 0)
