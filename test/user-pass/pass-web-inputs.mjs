// User pass, web app: the three ways of putting something other than typed words into a prompt.
// @file from the list, ! to run a command yourself, and a picture pasted from the clipboard.
import fs from "node:fs"
import path from "node:path"
import { check, failed, fakeModel, tempDir, web } from "./harness.mjs"

const model = await fakeModel(() => ({ text: "noted" }))
const project = tempDir("cg-inputs-project-")
fs.writeFileSync(path.join(project, "README.md"), "# Zebra Tracker\n")
fs.mkdirSync(path.join(project, "src")); fs.writeFileSync(path.join(project, "src", "zebra.ts"), "export const stripes = 42\n")
const w = await web({ model, cwd: project })
const lastUser = () => { const m = model.seen.at(-1).messages.filter((x) => x.role === "user").at(-1); return typeof m.content === "string" ? m.content : JSON.stringify(m.content) }
try {
  // @ opens a list of project files; typing narrows it; Enter (or Tab) puts the path in.
  await w.box.fill("what is in @zeb"); await w.page.waitForTimeout(600)
  const listed = await w.page.locator(".palette .prow .pvalue").allInnerTexts()
  check("@: typing part of a name lists the file", listed.some((v) => /src\/zebra\.ts/.test(v)), listed.slice(0, 4).join(" | "))
  await w.page.keyboard.press("Tab"); await w.page.waitForTimeout(300)
  check("@: picking it completes the path in the box", /@src\/zebra\.ts/.test(await w.box.inputValue()), await w.box.inputValue())
  await w.page.keyboard.press("Enter"); await w.page.waitForTimeout(1500)
  check("@: the model receives the file's contents", /stripes = 42/.test(lastUser()))
  check("@: the thread shows what was typed, not the file", !/stripes = 42/.test(await w.thread()) && /@src\/zebra\.ts/.test(await w.thread()))

  // ! runs a command without the model.
  const before = model.seen.length
  await w.send("!echo plum-4471", 2500)
  check("!: the output shows in the thread", (await w.thread()).replace(/!echo plum-4471/g, "").includes("plum-4471"))
  check("!: nothing was sent to the model for it", model.seen.length === before)
  await w.send("what did that print", 1500)
  check("!: the next prompt carries what the command printed", JSON.stringify(model.seen.at(-1).messages).replace(/echo plum-4471/g, "").includes("plum-4471"))

  // A pasted picture becomes an attachment.
  await w.box.focus()
  await w.page.evaluate(() => {
    const bytes = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0))
    const data = new DataTransfer(); data.items.add(new File([bytes], "shot.png", { type: "image/png" }))
    document.querySelector("textarea, [role=textbox]").dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }))
  })
  await w.page.waitForTimeout(600)
  const chips = await w.page.locator(".shot").count()
  check("paste: the picture shows as an attachment before sending", chips === 1, chips + " shown")
  await w.send("what is this", 1500)
  check("paste: the message goes out with the picture noted", /shot\.png|image/.test(lastUser()), lastUser().slice(0, 200))
  check("no console errors", w.errors.length === 0, w.errors.join(" | "))
} catch (error) { check("web inputs pass", false, error.message) } finally { await w.close() }
model.close()
console.log(failed() ? `\n${failed()} failed` : "\nall passed")
process.exit(0)
