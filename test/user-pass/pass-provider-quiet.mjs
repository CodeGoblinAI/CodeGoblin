// User pass: a provider that is slow to say anything. The spinner alone looked the same whether a model was
// thinking or the provider had stopped answering; now the silence is said, and the note goes once the answer
// comes. (The limits are scaled down here: a note from 1s rather than 20s.)
import { check, failed, fakeModel, tempDir, tui, web, delay, plain } from "./harness.mjs"

const model = await fakeModel(async (sent) => {
  const said = String(sent.messages.filter((m) => m.role === "user").at(-1)?.content ?? "")
  if (/slow/.test(said)) await delay(3500)
  return { text: "the slow answer arrived" }
})
const project = tempDir("cg-quiet-project-")
const extraEnv = { CG_STALL_MS: "4000" }

// --- TUI ---
const t = await tui({ model, cwd: project, extraEnv, cols: 140, rows: 36 })
const frame = () => plain(t.out.split("\x1b[2J").at(-1)).replace(/\r/g, "")
try {
  await delay(1200)
  t.write("slow please\r")
  let noted = ""
  for (let waited = 0; waited < 3200 && !noted; waited += 150) { await delay(150); noted = frame().split("\n").find((line) => /no output from the local model for \d+s/.test(line)) ?? "" }
  check("TUI: while nothing comes back, the status line says so, and for how long", Boolean(noted), frame().split("\n").slice(-6).join("\n"))
  check("TUI: and says that a local model reading a long prompt can take minutes", /reading a long prompt on the CPU can take minutes/.test(noted), noted.trim())
  await t.until((s) => /the slow answer arrived/.test(s), 10000, "answer")
  await delay(500)
  check("TUI: once the answer comes the note is gone", !/no output from the local model/.test(frame()), frame().split("\n").slice(-6).join("\n"))
} catch (error) { check("TUI pass", false, error.message + "\n" + frame().slice(-600)) } finally { t.kill() }

// --- Web ---
const w = await web({ model, cwd: project, extraEnv })
try {
  await w.send("/model local/fixture")
  await w.page.locator("#prompt, textarea").first().fill("slow please")
  await w.page.keyboard.press("Enter")
  let noted = ""
  for (let waited = 0; waited < 3200 && !/no output from the local model/.test(noted); waited += 150) { await w.page.waitForTimeout(150); noted = (await w.page.locator("#hint").textContent()) ?? "" }
  check("web: while nothing comes back, the hint says so, and for how long", /no output from the local model for \d+s/.test(noted), noted)
  await w.page.waitForFunction(() => document.body.innerText.includes("the slow answer arrived"), null, { timeout: 10000 })
  await w.page.waitForTimeout(400)
  check("web: once the answer comes the note is gone", !/no output/.test((await w.page.locator("#hint").textContent()) ?? ""), (await w.page.locator("#hint").textContent()) ?? "")
  check("web: no console errors", w.errors.length === 0, w.errors.join(" | "))
} catch (error) { check("web pass", false, error.message) } finally { await w.close() }
model.close()
console.log(failed() ? `\n${failed()} failed` : "\nall passed")
if (process.platform === "win32") process.kill(process.pid)
process.exit(failed() ? 1 : 0)
