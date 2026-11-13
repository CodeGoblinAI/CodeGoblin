// User pass: ctrl+x leader keys, /editor, the "worked for" line, and paste folding - TUI and web.
import path from "node:path"
import { fileURLToPath } from "node:url"
import { check, failed, fakeModel, tempDir, tui, web, delay } from "./harness.mjs"

const here = path.dirname(fileURLToPath(import.meta.url))
let lastUser = ""
const model = await fakeModel((sent) => {
  const user = sent.messages.filter((m) => m.role === "user").at(-1)
  lastUser = typeof user?.content === "string" ? user.content : JSON.stringify(user?.content)
  return { text: "got it" }
})
const project = tempDir("cg-qol-project-")
const pasteBody = ["line one", "line two", "line three", "line four", "line five"].join("\n")

// --- TUI ---
const t = await tui({ model, cwd: project, extraEnv: { VISUAL: `"${process.execPath}" "${path.join(here, "fake-editor.mjs")}"` } })
try {
  t.write("\x18"); await delay(300)
  check("TUI: ctrl+x shows the leader keys", /ctrl\+x\s+m model · l sessions · n new · s status/.test(t.screen()), t.screen().split("\n").filter((l) => /ctrl\+x/.test(l)).slice(-1).join(""))
  t.write("m"); await delay(700)
  check("TUI: ctrl+x m opens the model picker", /Choose model/.test(t.screen()))
  t.write("\x1b"); await delay(300)
  t.clear(); t.write("\x18"); await delay(150); t.write("s"); await delay(800)
  check("TUI: ctrl+x s opens /status", /working in/.test(t.screen()))
  t.write("\x1b"); await delay(300)
  // Paste: bracketed paste of five lines folds to a token, the model gets it all.
  t.clear(); t.write("\x1b[200~" + pasteBody + "\x1b[201~"); await delay(400)
  check("TUI: a five-line paste shows as [Pasted ~5 lines]", /\[Pasted ~5 lines\]/.test(t.screen()))
  t.write("\r")
  await t.until((s) => /got it/.test(s), 10000, "answer")
  await delay(400)
  check("TUI: the model got every pasted line", lastUser.includes("line five") && !lastUser.includes("[Pasted"), lastUser.slice(0, 80))
  check("TUI: a 'worked for' line follows the answer", /▣ worked for \d+(\.\d)?s · Local server/.test(t.screen()), t.screen().split("\n").filter((l) => /worked for/.test(l)).slice(-1).join(""))
  // /editor: the stand-in editor appends a line; it comes back unsent.
  t.clear(); t.write("draft here"); await delay(200)
  t.write("\x18"); await delay(150); t.write("e"); await delay(2500)
  const back = t.screen()
  check("TUI: ctrl+x e hands the draft to the editor and puts the result back unsent", /written in the editor/.test(back) && /enter sends it/.test(back), back.split("\n").filter((l) => /editor|draft/.test(l)).slice(-3).join("\n"))
} catch (error) { check("TUI pass", false, error.message) } finally { t.kill() }

// --- Web ---
const w = await web({ model, cwd: project })
try {
  await w.box.click()
  await w.page.evaluate((text) => {
    const box = document.querySelector("textarea, [aria-label='Message or slash command']")
    const data = new DataTransfer(); data.setData("text/plain", text)
    box.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }))
  }, pasteBody)
  check("web: a five-line paste becomes a token in the box", /^\[Pasted ~5 lines\]$/.test(await w.box.inputValue()), await w.box.inputValue())
  await w.page.keyboard.press("Enter"); await w.page.waitForTimeout(2000)
  check("web: the model got every line", lastUser.includes("line five") && !lastUser.includes("[Pasted"), lastUser.slice(0, 80))
  const thread = await w.thread()
  check("web: the conversation shows the token, not the wall of text", /\[Pasted ~5 lines\]/.test(thread) && !/line three/.test(thread), thread.slice(-200))
  check("web: a 'worked for' line follows the answer", /▣ worked for \d+(\.\d)?s/.test(thread))
  check("web: no console errors", w.errors.length === 0, w.errors.join(" | "))
} catch (error) { check("web pass", false, error.message) } finally { await w.close() }
model.close()
console.log(failed() ? `\n${failed()} failed` : "\nall passed")
process.exit(0)
