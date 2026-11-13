// User pass: /timestamps, /fold and /timeline in the TUI and the web.
import { check, failed, fakeModel, tempDir, tui, web, delay } from "./harness.mjs"

const long = Array.from({ length: 30 }, (_, i) => `answer line ${i + 1}`).join("\n\n")
const model = await fakeModel((sent) => {
  const user = sent.messages.filter((m) => m.role === "user").at(-1)?.content ?? ""
  return { text: /first/.test(user) ? "FIRST ANSWER\n\n" + long : "reply to " + user }
})
const project = tempDir("cg-timeline-project-")

// --- TUI ---
const t = await tui({ model, cwd: project, rows: 40 })
try {
  t.write("the first question\r"); await t.until((s) => /answer line 30/.test(s), 10000, "first answer")
  for (const q of ["second question", "third question"]) { t.write(q + "\r"); await t.until((s) => new RegExp("reply to " + q).test(s), 10000, q) }
  t.clear(); t.write("/timestamps\r"); await delay(700)
  check("TUI: /timestamps puts the time beside each message", /\d\d:\d\d · you/.test(t.screen()), t.screen().split("\n").filter((l) => /· you/.test(l)).slice(-1).join(""))
  t.clear(); t.write("/fold\r"); await delay(700)
  const folded = t.screen()
  check("TUI: /fold folds the long answer to its first lines", /more lines - \/fold unfolds/.test(folded), folded.split("\n").filter((l) => /more lines/.test(l)).slice(-1).join(""))
  t.clear(); t.write("/fold\r"); await delay(500)
  t.clear(); t.write("/timeline\r"); await delay(700)
  const list = t.screen()
  check("TUI: /timeline lists your messages, newest first", /Jump to a message/.test(list) && list.indexOf("third question") < list.indexOf("the first question"), list.split("\n").filter((l) => /question/.test(l)).slice(-3).join("\n"))
  t.write("\x1b[B\x1b[B\r"); await delay(800)
  // The first question's message now sits at the top of the conversation area.
  const top = t.screen().split("\n").slice(-40).slice(0, 6).join("\n")
  check("TUI: choosing the first question scrolls it to the top", /the first question/.test(top), top)
} catch (error) { check("TUI pass", false, error.message) } finally { t.kill() }

// --- Web ---
const w = await web({ model, cwd: project })
try {
  await w.send("the first question", 1500)
  await w.send("second question", 1200)
  await w.send("third question", 1200)
  await w.send("/timestamps", 400)
  check("web: /timestamps shows times", await w.page.locator(".turn .who .at").first().isVisible() && /\d\d:\d\d/.test(await w.page.locator(".turn .who .at").first().innerText()))
  await w.send("/fold", 400)
  const height = await w.page.locator(".turn.agent .body").filter({ hasText: "FIRST ANSWER" }).evaluate((el) => el.getBoundingClientRect().height)
  check("web: /fold folds the long answer", height < 90, String(height))
  await w.page.locator(".turn.agent .body").filter({ hasText: "FIRST ANSWER" }).click(); await w.page.waitForTimeout(300)
  const opened = await w.page.locator(".turn.agent .body").filter({ hasText: "FIRST ANSWER" }).evaluate((el) => el.getBoundingClientRect().height)
  check("web: clicking a folded answer opens it", opened > 300, String(opened))
  await w.send("/timeline", 600)
  const options = await w.page.locator("dialog .dialog-action").allInnerTexts()
  check("web: /timeline lists your messages, newest first, with times", options.length === 3 && /third question/.test(options[0]) && /\d\d:\d\d/.test(options[0]), options.join(" | "))
  await w.page.locator("dialog .dialog-action").filter({ hasText: "the first question" }).click(); await w.page.waitForTimeout(800)
  const top = await w.page.evaluate(() => { const el = [...document.querySelectorAll(".turn.user")].find((t) => /first question/.test(t.textContent)); const box = el.getBoundingClientRect(); const thread = document.getElementById("thread").getBoundingClientRect(); return box.top - thread.top })
  check("web: choosing one scrolls it to the top", top >= -5 && top < 80, String(top))
  check("web: no console errors", w.errors.length === 0, w.errors.join(" | "))
} catch (error) { check("web pass", false, error.message) } finally { await w.close() }
model.close()
console.log(failed() ? `\n${failed()} failed` : "\nall passed")
process.exit(0)
