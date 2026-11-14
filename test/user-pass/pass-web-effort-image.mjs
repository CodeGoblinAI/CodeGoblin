// User pass, web app: choosing a model with effort levels asks for one, once; and a picture named by its full
// path, outside the project, is attached to the message.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { check, failed, fakeModel, tempDir, web } from "./harness.mjs"

const model = await fakeModel(() => ({ text: "noted" }))
const project = tempDir("cg-webeffort-project-")
const outside = fs.mkdtempSync(path.join(os.tmpdir(), "cg desktop-"))
const shot = path.join(outside, "screen shot.png")
fs.writeFileSync(shot, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"))
const w = await web({ model, cwd: project })
const pick = async (name) => {
  await w.page.locator("#provider-btn").click(); await w.page.waitForTimeout(400)
  await w.page.locator("#provider-menu [role=option]", { hasText: name }).first().click(); await w.page.waitForTimeout(700)
}
const paletteValues = () => w.page.locator(".palette .prow .pvalue").allInnerTexts()
try {
  // A picture by full path, on the model the app starts with.
  await w.send("what is in " + shot + " ?", 1500)
  const sent = model.seen.at(-1).messages.filter((m) => m.role === "user").at(-1)
  const text = typeof sent.content === "string" ? sent.content : JSON.stringify(sent.content)
  check("a picture named by full path is attached: the model is told about it or sent it", /screen shot\.png/.test(text) && /image_url|attached/.test(text), text.replace(/base64,[A-Za-z0-9+/=]+/g, "base64,…").slice(0, 260))

  await pick("MiniMax M3.1 Flash")
  check("choosing a model with effort levels opens its levels in the composer", (await w.box.inputValue()) === "/effort ", JSON.stringify(await w.box.inputValue()))
  const levels = await paletteValues()
  check("the levels are this model's own: auto, low, high, max - no medium", levels.join(" ").includes("/effort low") && levels.join(" ").includes("/effort max") && !levels.join(" ").includes("medium"), levels.join(" | "))
  await w.box.fill("/effort high"); await w.page.keyboard.press("Enter"); await w.page.waitForTimeout(900)
  await pick("Kimi K3.1 Pro")
  await w.box.fill(""); await w.page.waitForTimeout(200)
  await pick("MiniMax M3.1 Flash")
  check("a model whose effort was answered is not asked again", (await w.box.inputValue()) === "", JSON.stringify(await w.box.inputValue()))
  await w.box.fill("half a thought"); await pick("GLM 5.3 Flash Abliterated")
  check("a draft in the composer is never replaced by the question", (await w.box.inputValue()) === "half a thought", JSON.stringify(await w.box.inputValue()))
  check("no console errors", w.errors.length === 0, w.errors.join(" | "))
} catch (error) { check("web effort and image pass", false, error.message) } finally { await w.close() }
model.close()
console.log(failed() ? `\n${failed()} failed` : "\nall passed")
process.exit(0)
