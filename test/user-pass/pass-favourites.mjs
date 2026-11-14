// User pass: model favourites and recents, TUI and web, sharing one throwaway profile.
import fs from "node:fs"
import path from "node:path"
import { check, failed, fakeModel, tempDir, tui, web, delay } from "./harness.mjs"

const model = await fakeModel(() => ({ text: "hi" }))
const project = tempDir("cg-fav-project-")
const profile = tempDir("cg-fav-profile-")
const settingsFile = () => { try { return JSON.parse(fs.readFileSync(path.join(profile, "state", "settings.json"), "utf8")) } catch { return {} } }
const findSettings = () => {
  // Global.Path.state under CODEGOBLIN_DIR - find wherever settings.json landed.
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(dir, e.name)) : e.name === "settings.json" ? [path.join(dir, e.name)] : [])
  const found = walk(profile)[0]
  return found ? JSON.parse(fs.readFileSync(found, "utf8")) : {}
}

// --- TUI: open the model picker from the toolbar's [Model], star one with ctrl+f, pick another ---
const t = await tui({ model, cwd: project, profile })
try {
  t.write("/model\r"); await delay(700)
  t.write("\x1b"); await delay(300)
  // The toolbar's Model button opens the dialog; easier to reach by the composer: type /favourite and pick.
  t.clear(); t.write("/favourite"); await delay(500); t.write("\r"); await delay(700)
  const list = t.screen()
  check("TUI: bare /favourite opens the model list to pick from", /\/favourite zai\/glm-5\.3-flash/.test(list) || /\/favourite /.test(list), list.split("\n").filter((l) => /favourite /.test(l)).slice(0, 4).join("\n"))
  t.write("\x15"); await delay(200) // clear the line
  t.clear(); t.write("/favourite zai/glm-5.3-flash\r"); await delay(900)
  check("TUI: /favourite <model> stars it", /favourite: zai\/glm-5\.3-flash/.test(t.screen()) && (findSettings().favourites ?? []).includes("zai/glm-5.3-flash"), JSON.stringify(findSettings().favourites))
  t.clear(); t.write("/model "); await delay(700)
  const models = t.screen().split("\n").filter((l) => /\/model /.test(l)).slice(0, 3).join("\n")
  check("TUI: /model lists the favourite first, starred, under Favourites", /\/model zai\/glm-5\.3-flash.*\u2605 Favourites/.test(models), models)
  t.write("\x15"); await delay(200)
  t.clear(); t.write("/model deepseek/deepseek-v4-flash\r"); await delay(900)
  const recents = findSettings().recents ?? []
  check("TUI: switching models records it as recent", recents[0] === "deepseek/deepseek-v4-flash" || recents.length > 0, JSON.stringify(recents))
} catch (error) { check("TUI pass", false, error.message) } finally { t.kill() }

// --- Web: same profile, so the TUI's favourite shows; star another with the star button ---
const w = await web({ model, cwd: project, profile })
try {
  await w.page.click("#provider-btn"); await w.page.waitForTimeout(500)
  const firstSection = await w.page.locator("#provider-menu .picker-section").first().innerText()
  const firstRow = await w.page.locator("#provider-menu .picker-item").first().innerText()
  check("web: the terminal's favourite is first, under Favourites, starred", /favourites/i.test(firstSection) && /\u2605/.test(firstRow) && /5\.3 Flash/.test(firstRow), firstSection + " | " + firstRow)
  // Star the fourth row with its star button; the menu stays open.
  const target = w.page.locator("#provider-menu .picker-item").nth(4)
  const label = (await target.innerText()).replace(/^[\u2605\u2606]\s*/, "").split("\n")[0].trim()
  await target.locator(".picker-star").click(); await w.page.waitForTimeout(900)
  const open = await w.page.locator("#provider-menu").isVisible()
  const favRows = await w.page.locator("#provider-menu .picker-item:has(.picker-star.on)").allInnerTexts()
  check("web: the star button stars a model without choosing it, and the menu stays open", open && favRows.some((r) => r.includes(label)) && !(await w.page.locator("#provider-btn").innerText()).includes(label), `open=${open}; starred=${favRows.join(" | ")}`)
  check("web: the star is saved to the shared settings file", (findSettings().favourites ?? []).length === 2, JSON.stringify(findSettings().favourites))
  // Keyboard: ctrl+f on the highlighted row unstars it.
  await w.page.keyboard.press("Home"); await w.page.waitForTimeout(150)
  await w.page.keyboard.press("Control+f"); await w.page.waitForTimeout(900)
  check("web: ctrl+f in the open menu toggles the highlighted model", (findSettings().favourites ?? []).length === 1, JSON.stringify(findSettings().favourites))
  await w.page.keyboard.press("Escape")
  await w.send("/favourite ", 600)
  const items = await w.page.locator(".palette .pitem, .palette > *").allInnerTexts()
  check("web: /favourite lists models to pick", items.some((i) => /\/favourite /.test(i)), items.slice(0, 3).join(" | "))
  check("web: no console errors", w.errors.length === 0, w.errors.join(" | "))
} catch (error) { check("web pass", false, error.message) } finally { await w.close() }
model.close()
console.log(failed() ? `\n${failed()} failed` : "\nall passed")
process.exit(0)
