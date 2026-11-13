// User pass: @agent hand-off (TUI + web), any-file attachments and /open (web).
import fs from "node:fs"
import path from "node:path"
import { check, failed, fakeModel, tempDir, tui, web, delay } from "./harness.mjs"

let last = { user: "", tools: [] }
const model = await fakeModel((sent) => {
  const user = sent.messages.filter((m) => m.role === "user").at(-1)
  last = { user: typeof user?.content === "string" ? user.content : JSON.stringify(user?.content), tools: (sent.tools ?? []).map((t) => t.function.name) }
  return { text: "noted" }
})
const project = tempDir("cg-extras-project-")
fs.mkdirSync(path.join(project, "src"))
fs.writeFileSync(path.join(project, "src", "theme.ts"), "export const theme = 'dracula'\nexport const accent = '#ff79c6'\n")
const notes = path.join(tempDir("cg-extras-upload-"), "meeting-notes.txt")
fs.writeFileSync(notes, "decided: ship on friday\n")

// --- TUI ---
const t = await tui({ model, cwd: project })
try {
  t.write("@ex"); await delay(500)
  check("TUI: @ at the start offers the explore agent", /@explore\s*agent - Reads and searches/.test(t.screen()), t.screen().split("\n").filter((l) => /@explore/.test(l)).slice(-1).join(""))
  t.write("\x15"); await delay(200)
  t.write("@explore where is the theme set?\r")
  await t.until((s) => /noted/.test(s), 10000, "answer")
  check("TUI: @explore hands the task to the subagent, with the task tool on for it", /Start the explore subagent/.test(last.user) && last.tools.includes("task"), last.user.slice(0, 120) + " | tools: " + last.tools.join(","))
  const before = model.seen.length
  await delay(800)
  t.write("plain question\r"); await t.until(() => model.seen.length > before, 10000, "second"); await delay(500)
  check("TUI: the next ordinary message has no subagents again", !last.tools.includes("task"), last.tools.join(","))
} catch (error) { check("TUI pass", false, error.message) } finally { t.kill() }

// --- Web ---
const w = await web({ model, cwd: project })
try {
  await w.box.fill("@ex"); await w.page.waitForTimeout(400)
  const items = await w.page.locator(".palette > *").allInnerTexts()
  check("web: @ at the start offers the explore agent first", /@explore/.test(items[0] ?? "") && /agent/.test(items[0] ?? ""), items.slice(0, 2).join(" | "))
  await w.send("@explore where is the theme set?", 1500)
  check("web: @explore hands off with subagents on", /Start the explore subagent/.test(last.user) && last.tools.includes("task"), last.tools.join(","))
  check("web: the conversation shows what you typed", /@explore where is the theme set\?/.test(await w.thread()))

  // Attach a text file through the file picker.
  await w.page.setInputFiles("#picker", notes); await w.page.waitForTimeout(500)
  check("web: a text file attaches as a named chip", /meeting-notes\.txt/.test(await w.page.locator(".attached, #attached").first().innerText().catch(() => "")))
  await w.send("summarise the attached notes", 1500)
  check("web: its contents reach the model", /Attached file meeting-notes\.txt:/.test(last.user) && /ship on friday/.test(last.user), last.user.slice(-120))
  check("web: and the thread shows the chip, not the contents", /meeting-notes\.txt/.test(await w.thread()) && !/ship on friday/.test(await w.thread()))

  // /open: find a file, read it, mention it.
  await w.send("/open", 600)
  await w.page.locator("dialog input.quick-open").fill("theme"); await w.page.waitForTimeout(300)
  await w.page.keyboard.press("Enter"); await w.page.waitForTimeout(800)
  const viewer = await w.page.locator("dialog.file-view .file-text").innerText().catch(() => "")
  check("web: /open finds the file and shows it with line numbers", /1\s+export const theme = 'dracula'/.test(viewer) && /2\s+export const accent/.test(viewer), viewer.slice(0, 120))
  await w.page.locator("dialog.file-view .dialog-action").click(); await w.page.waitForTimeout(300)
  check("web: Mention puts @path in the prompt", /@src\/theme\.ts/.test(await w.box.inputValue()), await w.box.inputValue())
  await w.box.fill("")
  await w.send("/open ../outside.txt", 600)
  check("web: a path outside the project is refused", /outside the project/.test(await w.note()), await w.note())
  check("web: no console errors", w.errors.length === 0, w.errors.join(" | "))
} catch (error) { check("web pass", false, error.message) } finally { await w.close() }
model.close()
console.log(failed() ? `\n${failed()} failed` : "\nall passed")
process.exit(0)
