// User pass, web app: a page opened fresh starts on the model used last (here or in the terminal), not the
// first in the list; and sending a message is what makes a model "the last used".
// (The harness switches every page to its scripted model as it opens, so "opened fresh" is a reload.)
import fs from "node:fs"
import path from "node:path"
import { check, failed, fakeModel, tempDir, web } from "./harness.mjs"

const model = await fakeModel(() => ({ text: "noted" }))
const profile = tempDir("cg-pass-web-")
const settingsFile = () => { const name = fs.readdirSync(profile, { recursive: true }).map(String).find((each) => /settings\.json$/.test(each)); return name ? path.join(profile, name) : undefined }
const stored = () => { const file = settingsFile(); return file ? JSON.parse(fs.readFileSync(file, "utf8")) : {} }
const label = (w) => w.page.evaluate(() => document.querySelector("#provider-btn .picker-label")?.textContent ?? "")
const loaded = (w) => w.page.waitForFunction(() => { const text = document.querySelector("#provider-btn .picker-label")?.textContent ?? ""; return text.trim().length > 2 && !/loading/i.test(text) }, null, { timeout: 20000 }).catch(() => {})

const w = await web({ model, cwd: tempDir("cg-lastmodel-project-"), profile })
try {
  const fixture = await label(w)
  // Another model was used last - in the terminal, say. The settings file is what both read.
  fs.writeFileSync(settingsFile(), JSON.stringify({ ...stored(), recents: ["zai/glm-5.3-flash", ...(stored().recents ?? [])] }))
  await w.page.reload(); await loaded(w); await w.page.waitForTimeout(400)
  const opened = await label(w)
  check("a page opened fresh is on the model used last", /GLM 5\.3 Flash/i.test(opened), opened + " (the scripted model is " + fixture + ")")

  // Back on the scripted model without choosing it from the list, a sent message is what records it.
  fs.writeFileSync(settingsFile(), JSON.stringify({ ...stored(), recents: ["local/fixture", "zai/glm-5.3-flash"] }))
  await w.page.reload(); await loaded(w); await w.page.waitForTimeout(400)
  check("and follows the list when it changes", (await label(w)) === fixture, await label(w))
  fs.writeFileSync(settingsFile(), JSON.stringify({ ...stored(), recents: ["zai/glm-5.3-flash", "local/fixture"] }))
  await w.box.fill("hello"); await w.page.keyboard.press("Enter")
  await w.page.waitForFunction(() => /noted/.test(document.querySelector(".thread")?.textContent ?? ""), null, { timeout: 15000 }).catch(() => {})
  await w.page.waitForTimeout(600)
  check("the answer came from the scripted model", model.seen.length === 1)
  check("sending a message makes its model the most recent", stored().recents?.[0] === "local/fixture", JSON.stringify(stored().recents))
  check("no console errors", w.errors.length === 0, w.errors.join(" | "))
} catch (error) { check("last model pass", false, error.message) } finally { await w.close() }
model.close()
console.log(failed() ? `\n${failed()} failed` : "\nall passed")
process.exit(0)
