// User pass: scrolling a long conversation (jump-to-bottom pill, paging, ctrl+end, ctrl+up/down between your
// messages, the view staying put while output arrives), two Esc presses to stop, and the ranked / list. TUI and web.
import { check, failed, fakeModel, tempDir, tui, web, delay, plain } from "./harness.mjs"

const long = (n) => Array.from({ length: 40 }, (_, i) => `answer ${n} line ${i + 1}`).join("\n\n")
let turns = 0
const model = await fakeModel(async (sent) => {
  const said = String(sent.messages.filter((m) => m.role === "user").at(-1)?.content ?? "")
  if (/slow/.test(said)) { await delay(6000); return { text: long("slow") } }
  return { text: long(++turns) }
})
const project = tempDir("cg-scroll-project-")
/** The last full repaint, as rows. */
const frame = (t) => plain(t.out.split("\x1b[2J").at(-1)).replace(/\r/g, "").split("\n")

// --- TUI ---
{
  const t = await tui({ model, cwd: project, cols: 110, rows: 32 })
  try {
    for (const prompt of ["first question", "second question", "third question"]) {
      t.write(prompt + "\r"); await t.until(() => /answer \d line 40/.test(frame(t).join("\n")), 10000, "answer to " + prompt); await delay(300)
    }
    check("TUI: at the bottom there is no jump pill", !/Jump to bottom/.test(frame(t).join("\n")))
    t.write("\x1b[5~"); await delay(400)
    const paged = frame(t).join("\n")
    check("TUI: page up moves a whole page and the pill appears", /Jump to bottom \(ctrl\+end\)/.test(paged) && !/answer 3 line 40/.test(paged))
    t.write("\x1b[1;5F"); await delay(400)
    check("TUI: ctrl+end goes back to the latest output", /answer 3 line 40/.test(frame(t).join("\n")) && !/Jump to bottom/.test(frame(t).join("\n")))
    t.write("\x1b[1;5A"); await delay(400)
    const up1 = frame(t)
    check("TUI: ctrl+up puts your last message at the top", up1.slice(0, 3).join(" ").includes("third question"), up1.slice(0, 3).join(" | "))
    t.write("\x1b[1;5A"); await delay(400)
    check("TUI: and again, the one before it", frame(t).slice(0, 3).join(" ").includes("second question"))
    t.write("\x1b[1;5B"); await delay(400)
    check("TUI: ctrl+down goes forward again", frame(t).slice(0, 3).join(" ").includes("third question"))
    // Scrolled up while a slow answer arrives: the view stays on what was being read.
    t.write("\x1b[1;5F"); await delay(200)
    t.write("a slow one\r"); await delay(600)
    t.write("\x1b[5~"); await delay(400)
    const before = frame(t).slice(0, 4).join("|")
    await t.until(() => /New output/.test(frame(t).join("\n")), 12000, "new output while scrolled")
    const after = frame(t).slice(0, 4).join("|")
    check("TUI: new output arriving below leaves the view where it was, and the pill says there is more", before === after, before + "  ->  " + after)
    t.write("\x1b[1;5F"); await delay(400)
    // Two presses stop a turn; one only asks for the second.
    t.write("another slow one\r"); await delay(800)
    t.write("\x1b"); await delay(500)
    const once = frame(t).join("\n")
    check("TUI: one Esc asks for another and does not stop", /press esc again to stop/.test(once) && !/✗ stopped/.test(once))
    t.write("\x1b"); await delay(800)
    check("TUI: a second Esc stops it", /stopped/.test(frame(t).join("\n")))
    // The / list ranks matches: a word inside a name finds it.
    t.write("/brain"); await delay(500)
    const listed = frame(t).filter((line) => /\/[a-z]/.test(line) && /│/.test(line)).map((line) => line.trim())
    check("TUI: /brain finds a skill with brain inside its name", listed.some((line) => /project-brain/.test(line)), listed.slice(0, 3).join(" | "))
    t.write("\x15"); await delay(200)
  } catch (error) { check("TUI pass", false, error.message) } finally { t.kill() }
}

// --- Web ---
{
  const w = await web({ model, cwd: project })
  try {
    for (const prompt of ["first question", "second question"]) await w.send(prompt, 1500)
    const jump = w.page.locator("#jump-bottom")
    check("web: at the bottom the jump button is hidden", await jump.isHidden())
    await w.page.locator("#thread").evaluate((el) => { el.scrollTop = 0; el.dispatchEvent(new Event("scroll")) }); await w.page.waitForTimeout(300)
    check("web: scrolled up, the jump button shows", await jump.isVisible() && /Jump to bottom/.test(await jump.innerText()))
    await jump.click(); await w.page.waitForTimeout(900)
    check("web: clicking it goes to the bottom and hides it", await jump.isHidden() && await w.page.locator("#thread").evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight < 60))
    await w.box.fill("/brain"); await w.page.waitForTimeout(400)
    const rows = await w.page.locator(".palette .prow .pvalue").allInnerTexts()
    check("web: /brain finds a skill with brain inside its name", rows.some((value) => /project-brain/.test(value)), rows.slice(0, 3).join(" | "))
    await w.box.fill("/browser"); await w.page.waitForTimeout(400)
    check("web: the command whose name was typed comes first", (await w.page.locator(".palette .prow .pvalue").first().innerText()) === "/browser")
    await w.box.fill("")
    check("web: no console errors", w.errors.length === 0, w.errors.join(" | "))
  } catch (error) { check("web pass", false, error.message) } finally { await w.close() }
}
model.close()
console.log(failed() ? `\n${failed()} failed` : "\nall passed")
process.exit(0)
