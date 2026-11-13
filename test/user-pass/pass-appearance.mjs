// User pass: Appearance (dark / light / system), paste summary and animations toggles, TUI and web.
import fs from "node:fs"
import path from "node:path"
import { check, failed, fakeModel, tempDir, tui, web, delay } from "./harness.mjs"

let lastUser = ""
const model = await fakeModel((sent) => { lastUser = String(sent.messages.filter((m) => m.role === "user").at(-1)?.content ?? ""); return { text: "ok" } })
const project = tempDir("cg-look-project-")
const settingsOf = (profile) => JSON.parse(fs.readFileSync(path.join(profile, "state", "settings.json"), "utf8"))

// --- TUI ---
{
  const t = await tui({ model, cwd: project })
  try {
    t.write("/settings\r"); await delay(800)
    check("TUI: Settings lists Appearance, Paste summary and Animations", /Appearance\s+dark/.test(t.screen()) && /Paste summary\s+on/.test(t.screen()) && /Animations\s+on/.test(t.screen()))
    // Move to Appearance (row 4) and press enter: dark -> light.
    t.write("\x1b[B\x1b[B\x1b[B\r"); await delay(700)
    check("TUI: Appearance cycles to light and is saved", /Appearance\s+light/.test(t.screen()) && settingsOf(t.profile).appearance === "light")
    // The light theme is painted: paper's background colour appears in the frame.
    check("TUI: the light theme is drawn", /48;2;251;250;247|\x1b\[48;2;251;250;247/.test(t.out) || /251;250;247/.test(t.out))
    t.write("\x1b[B\r"); await delay(500) // Paste summary off
    check("TUI: Paste summary turns off", settingsOf(t.profile).pasteSummary === false)
    t.write("\x1b"); await delay(300)
    t.write("\x1b[200~a\nb\nc\nd\ne\x1b[201~"); await delay(400)
    check("TUI: with it off, a long paste goes in whole", !/\[Pasted ~5 lines\]/.test(t.screen().split("\n").slice(-8).join("\n")))
  } catch (error) { check("TUI pass", false, error.message) } finally { t.kill() }
}

// --- Web ---
{
  const w = await web({ model, cwd: project })
  const bg = () => w.page.evaluate(() => getComputedStyle(document.body).backgroundColor)
  try {
    const dark = await bg()
    await w.page.click("#settings-open"); await w.page.waitForTimeout(400)
    await w.page.locator("dialog label", { hasText: "Appearance" }).locator("select").selectOption("light"); await w.page.waitForTimeout(700)
    const light = await bg()
    check("web: Appearance light paints the light theme", light === "rgb(251, 250, 247)" && dark !== light, dark + " -> " + light)
    await w.page.locator("dialog label", { hasText: "Appearance" }).locator("select").selectOption("system"); await w.page.waitForTimeout(500)
    await w.page.emulateMedia({ colorScheme: "dark" }); await w.page.waitForTimeout(400)
    const systemDark = await bg()
    await w.page.emulateMedia({ colorScheme: "light" }); await w.page.waitForTimeout(400)
    const systemLight = await bg()
    check("web: System follows the browser as it changes", systemDark !== "rgb(251, 250, 247)" && systemLight === "rgb(251, 250, 247)", systemDark + " / " + systemLight)
    await w.page.locator("dialog label", { hasText: "Animations" }).locator("select").selectOption("off"); await w.page.waitForTimeout(400)
    check("web: Animations off stops motion on the page", await w.page.evaluate(() => document.body.classList.contains("no-animations")))
    await w.page.locator("dialog label", { hasText: "Paste summary" }).locator("select").selectOption("off"); await w.page.waitForTimeout(400)
    await w.page.keyboard.press("Escape")
    await w.box.click()
    await w.page.evaluate(() => { const data = new DataTransfer(); data.setData("text/plain", "a\nb\nc\nd\ne"); document.querySelector("[aria-label='Message or slash command']").dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true })) })
    check("web: Paste summary off leaves pastes whole", !/\[Pasted/.test(await w.box.inputValue()))
    check("web: no console errors", w.errors.length === 0, w.errors.join(" | "))
  } catch (error) { check("web pass", false, error.message) } finally { await w.close() }
}
model.close()
console.log(failed() ? `\n${failed()} failed` : "\nall passed")
process.exit(0)
