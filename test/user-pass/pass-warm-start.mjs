// User pass, terminal: starting the way a person does every day after the first - no --model, in a profile
// that has been used before, so the model catalogue answers from its cache at once.
// That catalogue used to finish while startup was still reading the settings, redraw a screen that did not
// exist yet, and end the app a moment after the home screen appeared (2026-11-15). Every scripted pass had
// started on a brand-new profile, where the catalogue is slow, so none of them saw it.
import fs from "node:fs"
import path from "node:path"
import { check, failed, fakeModel, tempDir, tui, delay, plain } from "./harness.mjs"

const model = await fakeModel(() => ({ text: "noted" }))
const profile = tempDir("cg-pass-profile-")
// A catalogue cache written a moment ago: read straight from disk, no network.
fs.mkdirSync(path.join(profile, "cache"), { recursive: true })
fs.writeFileSync(path.join(profile, "cache", "models-dev.json"), JSON.stringify({ groq: { id: "groq", name: "Groq", env: ["GROQ_API_KEY"], npm: "@ai-sdk/groq", models: { "llama-x": { id: "llama-x", name: "Llama X", tool_call: true, limit: { context: 8000 } } } } }))
// And settings that name a model used last, which is what makes startup wait on a file.
fs.mkdirSync(path.join(profile, "state"), { recursive: true })
fs.writeFileSync(path.join(profile, "state", "settings.json"), JSON.stringify({ recents: ["local/fixture"] }))

for (let round = 1; round <= 3; round++) {
  let exit
  const t = await tui({ model, cwd: tempDir("cg-warm-project-"), profile, cols: 110, rows: 30, args: [] }).catch((error) => ({ failed: error.message }))
  if (t.failed) { check("start " + round + ": the home screen appears", false, t.failed.slice(0, 600)); continue }
  t.term.onExit((event) => { exit = event })
  await delay(3500)
  check("start " + round + ": still running a few seconds after the home screen appears", exit === undefined, JSON.stringify(exit) + "\n" + plain(t.out).slice(-500))
  check("start " + round + ": on the model used last, with nothing gone wrong", /ask · Local server fixture/.test(plain(t.out)) && !/ReferenceError|Bun v\d|something went wrong/.test(plain(t.out)), plain(t.out).slice(-400))
  for (const char of "hello") { t.write(char); await delay(40) }
  t.write("\r")
  let answered = false
  for (let waited = 0; waited < 10000 && !answered; waited += 200) { answered = /noted/.test(plain(t.out)); await delay(200) }
  check("start " + round + ": and it answers", answered)
  t.kill(); await delay(400)
}
const log = path.join(profile, "data", "log", "tui-crash.log")
check("nothing was written to the crash log", !fs.existsSync(log), fs.existsSync(log) ? fs.readFileSync(log, "utf8").slice(0, 400) : "")
model.close()
process.stdout.write((failed() ? `\n${failed()} failed` : "\nall passed") + "\n", () => process.kill(process.pid, "SIGKILL"))
