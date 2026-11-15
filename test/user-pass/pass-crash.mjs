// User pass, terminal: something throws that nothing caught.
// 1. Once: the app stays up, says so in the status line, and the error is in the log file.
// 2. A background task failing: the same.
// 3. Again and again, or while drawing the screen: the app ends, but hands the terminal back first
//    (its own screen left, the mouse released) and prints the error where it can be read.
// F12 is the made-up failure (CODEGOBLIN_DEBUG_CRASH), there for this walkthrough only.
import fs from "node:fs"
import path from "node:path"
import { check, failed, fakeModel, tempDir, tui, delay, plain } from "./harness.mjs"

const model = await fakeModel(() => ({ text: "noted" }))
const screenOf = (t) => plain(t.out.split("\x1b[2J").at(-1)).replace(/\r/g, "")
const waitFor = async (t, pattern, ms = 12000) => { for (let waited = 0; waited < ms; waited += 200) { if (pattern.test(plain(t.out))) return true; await delay(200) } return false }
const logOf = (profile) => { const file = path.join(profile, "data", "log", "tui-crash.log"); return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "" }
const F12 = "\x1b[24~"
const LEFT_APP_SCREEN = "\x1b[?1049l"

async function run(kind, body) {
  const profile = tempDir("cg-pass-profile-")
  const t = await tui({ model, cwd: tempDir("cg-crash-project-"), profile, cols: 110, rows: 30, extraEnv: { CODEGOBLIN_DEBUG_CRASH: kind } })
  let exit
  t.term.onExit((event) => { exit = event })
  try { await waitFor(t, /ask · /); await body(t, profile, () => exit) } catch (error) { check(kind + " pass", false, error.message) } finally { try { t.kill() } catch {} }
}

await run("now", async (t, profile, exit) => {
  t.write(F12)
  check("one error: the status line says what went wrong", await waitFor(t, /something went wrong: a made-up failure/), screenOf(t).split("\n").filter((l) => /wrong/.test(l)).join(" | "))
  const shown = screenOf(t).replace(/\n\s*[│|]?\s*/g, "")
  check("the whole error is in the conversation: its stack, and the file it is saved in", /something went wrong \(an error nothing caught\)/.test(screenOf(t)) && /app\.ts/.test(shown) && /saved in .*tui-crash\.log/.test(shown), screenOf(t).slice(0, 900))
  check("the app is still running", exit() === undefined)
  check("the error is in the log, with its stack", /an error nothing caught/.test(logOf(profile)) && /a made-up failure/.test(logOf(profile)) && /app\.ts/.test(logOf(profile)), logOf(profile).slice(0, 300))
  for (const char of "hello") { t.write(char); await delay(40) }
  t.write("\r")
  check("and it still answers", await waitFor(t, /noted/))
  check("without leaving its screen", !t.out.includes(LEFT_APP_SCREEN))

  // The same error again and again is not carried on from.
  for (let n = 0; n < 4; n++) { t.write(F12); await delay(150) }
  for (let waited = 0; waited < 6000 && exit() === undefined; waited += 200) await delay(200)
  check("errors that keep coming end the app", exit() !== undefined && exit().exitCode === 1, JSON.stringify(exit()))
  // (The pseudo-console keeps the mouse switches to itself, so only leaving the screen can be seen from here.)
  check("the terminal is handed back first: the app's screen is left", t.out.includes(LEFT_APP_SCREEN))
  const after = plain(t.out.slice(t.out.lastIndexOf(LEFT_APP_SCREEN)))
  check("and the error is printed after that, where it can be read", /CodeGoblin stopped on an error it did not expect/.test(after) && /a made-up failure/.test(after) && /tui-crash\.log/.test(after) && /\/resume/.test(after), after.slice(0, 400))
})

await run("later", async (t, profile, exit) => {
  t.write(F12)
  check("a background task failing is shown too", await waitFor(t, /something went wrong: a made-up background failure/))
  check("and logged as that", /a background task failed/.test(logOf(profile)), logOf(profile).slice(0, 200))
  await delay(500)
  check("and the app is still running", exit() === undefined)
})

await run("draw", async (t, profile, exit) => {
  t.write(F12)
  for (let waited = 0; waited < 6000 && exit() === undefined; waited += 200) await delay(200)
  check("an error while drawing the screen ends the app at once", exit() !== undefined && exit().exitCode === 1, JSON.stringify(exit()))
  const after = plain(t.out.slice(Math.max(0, t.out.lastIndexOf(LEFT_APP_SCREEN))))
  check("with the terminal handed back and the error printed", t.out.includes(LEFT_APP_SCREEN) && /stopped on an error it did not expect \(drawing the screen\)/.test(after), after.slice(0, 300))
  check("and logged", /drawing the screen/.test(logOf(profile)))
})

model.close()
process.stdout.write((failed() ? `\n${failed()} failed` : "\nall passed") + "\n", () => process.kill(process.pid, "SIGKILL"))
