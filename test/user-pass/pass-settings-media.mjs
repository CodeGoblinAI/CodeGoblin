// User pass, web app: Settings has Images, Audio, 3D models and Memory. A generation setting is kept for the model
// it was set on; a memory added there reaches the model on the next turn and can be forgotten again.
import fs from "node:fs"
import path from "node:path"
import { check, failed, fakeModel, tempDir, web } from "./harness.mjs"

const model = await fakeModel(() => ({ text: "noted" }))
const project = tempDir("cg-setmedia-project-")
const w = await web({ model, cwd: project })
const page = w.page
const tab = (name) => page.locator(".set-tab", { hasText: new RegExp("^" + name + "$") })
const rowOf = (title) => page.locator(".set-row", { has: page.locator(".set-title", { hasText: title }) })
try {
  await w.send("/settings", 600)
  const tabs = await page.locator(".set-tab").allInnerTexts()
  check("Settings lists Images, Audio, 3D models and Memory", ["Images", "Audio", "3D models", "Memory"].every((name) => tabs.includes(name)), tabs.join(" | "))

  for (const name of ["Images", "Audio", "3D models"]) {
    await tab(name).click(); await page.waitForTimeout(300)
    const titles = await page.locator(".set-title").allInnerTexts()
    const models = await rowOf("Model").first().locator("option").allInnerTexts()
    check(name + ": a model to choose and its settings", titles[0] === "Model" && models.length > 0 && titles.length >= 3, titles.join(" | ") + "  //  " + models.slice(0, 3).join(", "))
    if (process.env.SHOW) console.log(name, titles, models)
  }

  // Change a setting on one voice model, look at another, and see each keeps its own.
  await tab("Audio").click(); await page.waitForTimeout(300)
  const picker = rowOf("Model").first().locator("select")
  const voiceModels = await picker.locator("option").evaluateAll((options) => options.map((option) => option.value))
  const format = () => rowOf("Audio format").locator("select")
  const values = await format().locator("option").evaluateAll((options) => options.map((option) => option.value))
  const wanted = values.find((value) => value !== "default")
  await format().selectOption(wanted); await page.waitForTimeout(600)
  const stored = JSON.parse(fs.readFileSync(path.join(w.profile, "state", "media.json"), "utf8"))
  check("Audio: a changed setting is saved for that model", Object.entries(stored).some(([key, value]) => key.startsWith(voiceModels[0]) && value === wanted), JSON.stringify(stored))
  await picker.selectOption(voiceModels[1]); await page.waitForTimeout(400)
  const other = await format().inputValue()
  await rowOf("Model").first().locator("select").selectOption(voiceModels[0]); await page.waitForTimeout(400)
  check("Audio: another model shows its own value, and the first keeps the change", (await format().inputValue()) === wanted && other === "default", "first=" + (await format().inputValue()) + " other=" + other)
  await page.keyboard.press("Escape"); await w.send("/settings", 600); await tab("Audio").click(); await page.waitForTimeout(300)
  check("Audio: the change is still there after reopening", (await format().inputValue()) === wanted)

  // Memory.
  await tab("Memory").click(); await page.waitForTimeout(400)
  check("Memory: starts empty and says so", /Nothing remembered yet/.test(await page.locator(".set-rows").innerText()))
  const field = page.getByRole("textbox", { name: "Something to remember" })
  await field.fill("the mascot is called Grobnar"); await field.press("Enter"); await page.waitForTimeout(700)
  check("Memory: what was added is listed with a way to forget it", (await rowOf("the mascot is called Grobnar").locator("button").innerText()) === "Forget")
  await page.keyboard.press("Escape"); await page.waitForTimeout(200)
  await w.send("hello", 1500)
  check("Memory: the model is told it on the next turn", JSON.stringify(model.seen.at(-1).messages).includes("Grobnar"))
  await w.send("/settings", 600); await tab("Memory").click(); await page.waitForTimeout(400)
  // Clicking a memory's words must not forget it: only the button does.
  await rowOf("the mascot is called Grobnar").locator(".set-title").click(); await page.waitForTimeout(500)
  check("Memory: clicking the text of a memory leaves it alone", (await rowOf("the mascot is called Grobnar").count()) === 1)
  await rowOf("the mascot is called Grobnar").locator("button").click(); await page.waitForTimeout(700)
  check("Memory: Forget removes it", /Nothing remembered yet/.test(await page.locator(".set-rows").innerText()))
  for (const fact of ["first fact", "second fact"]) { const box = page.getByRole("textbox", { name: "Something to remember" }); await box.fill(fact); await box.press("Enter"); await page.waitForTimeout(700) }
  const all = rowOf("Forget everything").locator("button")
  await all.click(); await page.waitForTimeout(300)
  check("Memory: Forget all asks first", /Really forget all 2/.test(await all.innerText()) && (await rowOf("first fact").count()) === 1)
  await all.click(); await page.waitForTimeout(1200)
  check("Memory: a second click forgets them", /Nothing remembered yet/.test(await page.locator(".set-rows").innerText()))
  await page.locator(".set-pane input[type=search]").fill("voice"); await page.waitForTimeout(300)
  check("Settings search finds a generation setting", (await page.locator(".set-row").count()) > 0, (await page.locator(".set-title").allInnerTexts()).join(" | "))
  await page.screenshot({ path: "output/shots/settings-images.png" }).catch(() => {})
  check("no console errors", w.errors.length === 0, w.errors.join(" | "))
} catch (error) { check("settings pass", false, error.message) } finally { await w.close() }
model.close()
console.log(failed() ? `\n${failed()} failed` : "\nall passed")
process.exit(0)
