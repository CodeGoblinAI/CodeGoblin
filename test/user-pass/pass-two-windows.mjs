// User pass: one conversation carried on in the terminal and in the web at once. Each window saved its own
// whole copy, so the terminal's next save wiped out the turn taken on the web. Now both are kept: the
// window that saves second goes on in a copy, and says so.
import fs from "node:fs"
import path from "node:path"
import { check, failed, fakeModel, tempDir, tui, web, delay, plain } from "./harness.mjs"

const model = await fakeModel((sent) => ({ text: "reply to: " + String(sent.messages.filter((m) => m.role === "user").at(-1)?.content ?? "") }))
const profile = tempDir("cg-two-profile-")
const project = tempDir("cg-two-project-")
const store = path.join(profile, "state", "sessions")
const saved = () => fs.existsSync(store) ? fs.readdirSync(store).filter((name) => name.endsWith(".json")).map((name) => JSON.parse(fs.readFileSync(path.join(store, name), "utf8"))) : []
const said = (session) => session.messages.filter((m) => m.role === "user").map((m) => m.content)

const t = await tui({ model, cwd: project, profile, cols: 140, rows: 40 })
let w
try {
  await delay(1200)
  t.write("terminal one\r"); await t.until((s) => /reply to: terminal one/.test(s), 10000, "first reply")
  await delay(600)

  // The web opens the same conversation and takes a turn in it.
  w = await web({ model, cwd: project, profile })
  await w.send("/model local/fixture")
  await w.page.locator("#session-list").getByText("terminal one").first().click()
  await w.page.waitForTimeout(1200)
  await w.send("web two", 2500)
  check("web: the conversation the terminal started opens, and takes a turn", /reply to: web two/.test(await w.thread()), (await w.thread()).slice(-200))

  // The terminal, which still has it open, carries on too.
  t.write("terminal three\r"); await t.until((s) => /reply to: terminal three/.test(s), 10000, "third reply")
  await delay(800)
  const screen = plain(t.out.split("\x1b[2J").at(-1)).replace(/\r/g, "")
  check("terminal: says the conversation was carried on in another window too, and that both are kept", /also carried on in another window/.test(screen) && /Both are kept/.test(screen), screen.split("\n").filter((l) => /window|kept/.test(l)).join("\n"))

  const all = saved()
  const web2 = all.find((session) => said(session).includes("web two"))
  const term3 = all.find((session) => said(session).includes("terminal three"))
  check("nothing is lost: the web's turn is on disk", Boolean(web2) && said(web2).join(",") === "terminal one,web two", web2 ? said(web2).join(",") : all.map((s) => said(s).join(",")).join(" / "))
  check("and the terminal's, in a copy of its own", Boolean(term3) && term3.id !== web2?.id && said(term3).join(",") === "terminal one,terminal three" && /\(this window\)$/.test(term3.title), term3 ? term3.title + ": " + said(term3).join(",") : "")

  // Each carries on in its own: the terminal in the copy, the web in the original.
  t.write("terminal four\r"); await t.until((s) => /reply to: terminal four/.test(s), 10000, "fourth reply")
  await w.send("web five", 2500)
  await delay(600)
  const after = saved()
  check("from then on each window carries on in its own conversation, with no more copies", after.length === 2 && said(after.find((s) => s.id === term3?.id) ?? { messages: [] }).includes("terminal four") && said(after.find((s) => s.id === web2?.id) ?? { messages: [] }).includes("web five"), after.map((s) => s.title + ": " + said(s).join(",")).join(" / "))
  check("web: no console errors", w.errors.length === 0, w.errors.join(" | "))
} catch (error) { check("pass", false, error.message) } finally { t.kill(); await w?.close() }
model.close()
console.log(failed() ? `\n${failed()} failed` : "\nall passed")
if (process.platform === "win32") process.kill(process.pid)
process.exit(failed() ? 1 : 0)
