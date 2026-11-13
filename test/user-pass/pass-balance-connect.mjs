// User pass: /balance explabs (one real read-only call; key passed in env only, never printed) and the short /connect list.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { check, failed, fakeModel, tempDir, tui, web, delay } from "./harness.mjs"
const store = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".local", "share", "codegoblin", "auth.json"), "utf8"))
const extraEnv = { EXPLABS_API_KEY: store.explabs?.key ?? "" }
const model = await fakeModel(() => ({ text: "ok" }))
const project = tempDir("cg-bal-project-")

// --- TUI ---
{
  const t = await tui({ model, cwd: project, extraEnv })
  try {
    t.write("/balance explabs\r")
    await t.until((s) => /Credits left|Balance unavailable|refused/.test(s), 15000, "balance")
    const rows = t.screen().split("\n").filter((l) => /Credits left|Total credits|Used|This key|Daily limit|balance status/.test(l)).slice(-7).map((l) => l.replace(/\d+\.\d\d/g, "#.##")).join("\n")
    check("TUI: /balance explabs shows credits left, totals and this key's spend", /Credits left/.test(t.screen()) && /This key today/.test(t.screen()) && /Daily limit/.test(t.screen()), rows)
    t.write("\x1b"); await delay(300)
    t.clear(); t.write("/balance zai\r"); await delay(1200)
    check("TUI: /balance zai says Z.ai has no balance API and where to look", /Z\.ai has no balance API/.test(t.screen()))
    t.write("\x1b"); await delay(300)
    await delay(5000) // models.dev loads in the background
    t.clear(); t.write("/connect "); await delay(800)
    const listed = t.screen().split("\n").filter((l) => /\/connect /.test(l))
    const count = Number((t.screen().match(/1 of (\d+)/g) ?? []).at(-1)?.split(" of ")[1] ?? 999)
    check("TUI: /connect shows a short list, not all ~200", count < 35 && !/\/connect nvidia/.test(t.screen()), count + " rows; " + listed.length)
    t.write("nvidia"); await delay(600)
    check("TUI: typing finds any of the others", /\/connect nvidia/.test(t.screen()), t.screen().split("\n").filter((l) => /nvidia/i.test(l)).slice(-1).join(""))
  } catch (error) { check("TUI pass", false, error.message) } finally { t.kill() }
}

// --- Web ---
{
  const w = await web({ model, cwd: project, extraEnv })
  try {
    await w.page.waitForTimeout(5000)
    await w.page.reload(); await w.page.waitForTimeout(1200); await w.fixture()
    await w.box.fill("/connect "); await w.page.waitForTimeout(500)
    const items = await w.page.locator(".palette > *").allInnerTexts()
    check("web: /connect shows the short list, ending in how many more", items.length < 35 && /more providers/.test(items.at(-1) ?? ""), items.length + " rows; last: " + (items.at(-1) ?? "").replace(/\s+/g, " "))
    await w.box.fill("/connect nvidia"); await w.page.waitForTimeout(500)
    check("web: typing searches all of them", (await w.page.locator(".palette > *").allInnerTexts()).some((i) => /nvidia/i.test(i)))
    const balance = await w.page.evaluate(async () => (await fetch("/api/balance?provider=explabs")).json().catch(() => ({})))
    check("web: the explabs balance comes back ready", balance.state === "ready" && balance.entries?.some((e) => e.label === "Credits left"), JSON.stringify({ state: balance.state, labels: (balance.entries ?? []).map((e) => e.label) }))
    check("web: no console errors", w.errors.length === 0, w.errors.join(" | "))
  } catch (error) { check("web pass", false, error.message) } finally { await w.close() }
}
model.close()
console.log(failed() ? `\n${failed()} failed` : "\nall passed")
process.exit(0)
