// User pass: /browser on starts the real Chrome DevTools server and a real Chrome (own profile, in the throwaway
// CODEGOBLIN_DIR); the fake model opens CG-Next's own page in it and reads it back; /browser off closes it.
// This opens a Chrome window for a few seconds. Needs npx on PATH; the first run downloads the pinned server.
import path from "node:path"
import fs from "node:fs"
import { check, failed, fakeModel, tempDir, tui, web, delay } from "./harness.mjs"
let target = ""
const model = await fakeModel((sent, n) => {
  const last = sent.messages.at(-1)
  if (last.role === "user") return { tool: "mcp__browser__new_page", args: { url: target } }
  if (last.role === "tool" && /## Pages/.test(String(last.content)) && !sent.messages.some((m) => m.role === "tool" && /page snapshot/.test(String(m.content)))) return { tool: "mcp__browser__take_snapshot", args: {} }
  const snapshot = String(sent.messages.findLast((m) => m.role === "tool")?.content ?? "")
  return { text: /What should we work on/.test(snapshot) ? "The page asks: What should we work on?" : "I could not read the page: " + snapshot.slice(0, 200) }
})
const project = tempDir("cg-browser-project-")

// --- Web ---
{
  const w = await web({ model, cwd: project })
  target = w.url
  try {
    await w.send("/browser", 600)
    check("web: /browser says it is off and how to turn it on", /browser: off\. \/browser on opens a separate Chrome/.test(await w.note()), await w.note())
    await w.send("/browser on", 500)
    await w.page.waitForFunction(() => /browser: (on|not running)/.test([...document.querySelectorAll(".tool.note")].at(-1)?.textContent ?? ""), null, { timeout: 150000 })
    check("web: /browser on starts it and counts its tools", /browser: on, a separate Chrome, 20 tools/.test(await w.note()), await w.note())
    const tools = await w.page.evaluate(async () => (await fetch("/api/mcp?sessionId=")).json())
    check("web: it shows under /mcp as a connected server", tools.servers?.some((s) => s.name === "browser" && s.status === "connected" && s.tools.includes("take_snapshot") && !s.tools.includes("take_screenshot")))
    await w.send("Open this app in the browser and tell me what it asks", 1500)
    // Each browser tool asks first, like any other tool outside the project.
    for (let step = 0; step < 4; step++) {
      const allow = w.page.locator(".pallow").first()
      if (await allow.isVisible().catch(() => false)) { await allow.click(); await w.page.waitForTimeout(3500) } else await w.page.waitForTimeout(1500)
      if (/What should we work on\?|could not read/.test((await w.page.locator(".turn.agent .body").allInnerTexts()).join(" "))) break
    }
    const answer = (await w.page.locator(".turn.agent .body").allInnerTexts()).join(" ")
    check("web: the model opened a page in the real browser and read it back", /The page asks: What should we work on\?/.test(answer), answer.slice(0, 200) + " | tools: " + (await w.page.locator(".tool .tname").allInnerTexts()).join(","))
    check("web: its Chrome keeps a profile of its own under the app's state folder", fs.existsSync(path.join(w.profile, "state", "browser-profile")), path.join(w.profile, "state", "browser-profile"))
    await w.page.screenshot({ path: path.join(import.meta.dirname, "../../output/shots/next-browser.png") }).catch(() => {})
    await w.send("/browser off", 2500)
    check("web: /browser off closes it", /browser: off\./.test(await w.note()), await w.note())
    check("web: no console errors", w.errors.length === 0, w.errors.join(" | "))
  } catch (error) { check("web pass", false, error.message) } finally { await w.close() }
}

// --- TUI ---
{
  const t = await tui({ model, cwd: project })
  try {
    t.write("/browser\r"); await delay(900)
    check("TUI: /browser says it is off and how to turn it on", /browser: off\. \/browser on opens/.test(t.screen()))
    t.clear(); t.write("/browser on\r")
    await t.until((s) => /browser: (on|not running)/.test(s), 150000, "browser on")
    check("TUI: /browser on starts it", /browser: on, a separate Chrome, 20 tools/.test(t.screen()), t.screen().split("\n").filter((l) => /browser:/.test(l)).slice(-1).join(""))
    t.clear(); t.write("/browser off\r")
    await t.until((s) => /browser: off\./.test(s), 20000, "browser off")
    check("TUI: /browser off closes it", true)
  } catch (error) { check("TUI pass", false, error.message) } finally { t.kill() }
}
model.close()
console.log(failed() ? `\n${failed()} failed` : "\nall passed")
process.exit(0)
