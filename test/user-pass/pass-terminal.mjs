// User pass: /terminal in the browser - a real shell in the project folder; refused to anything but the page.
import fs from "node:fs"
import path from "node:path"
import { check, failed, fakeModel, tempDir, web } from "./harness.mjs"

const model = await fakeModel(() => ({ text: "ok" }))
const project = tempDir("cg-term-project-")
fs.writeFileSync(path.join(project, "marker-file.txt"), "x")
const w = await web({ model, cwd: project })
const page = w.page
const screen = () => page.evaluate(() => [...document.querySelectorAll("#terminal-view .xterm-rows > div")].map((row) => row.textContent).join("\n"))
try {
  await w.send("/terminal", 3500)
  check("/terminal opens the panel under the conversation", await page.locator("#terminal-panel").isVisible())
  await page.waitForFunction(() => document.querySelectorAll("#terminal-view .xterm-rows > div").length > 0, null, { timeout: 15000 })
  await page.waitForTimeout(2500)
  await page.locator("#terminal-view").click()
  await page.keyboard.type("Get-ChildItem -Name; echo ('hello-' + 'from-the-terminal')")
  await page.keyboard.press("Enter")
  await page.waitForFunction(() => /hello-from-the-terminal/.test(document.querySelector("#terminal-view").innerText), null, { timeout: 15000 }).catch(() => {})
  const text = await screen()
  check("typing runs in a real shell, in the project folder", /hello-from-the-terminal/.test(text) && /marker-file\.txt/.test(text), text.split("\n").filter((l) => l.trim()).slice(-6).join("\n"))
  await page.keyboard.press("Control+`"); await page.waitForTimeout(500)
  check("ctrl+` closes it", !(await page.locator("#terminal-panel").isVisible()))
  await page.keyboard.press("Control+`"); await page.waitForTimeout(3000)
  check("and opens a fresh one", await page.locator("#terminal-panel").isVisible())
  await page.locator("#terminal-close").click(); await page.waitForTimeout(400)
  // Anything but the page itself is refused: no Origin (a script), or another origin.
  const refused = await new Promise((resolve) => {
    const socket = new WebSocket(w.url.replace("http", "ws") + "/api/terminal")
    socket.onopen = () => { socket.close(); resolve(false) }
    socket.onerror = () => resolve(true)
  })
  check("a WebSocket from outside the page is refused", refused === true)
  const crossOrigin = await fetch(w.url + "/api/terminal", { headers: { origin: "https://evil.example" } })
  check("and so is one claiming another origin", crossOrigin.status === 403, String(crossOrigin.status))
  check("no console errors", w.errors.length === 0, w.errors.join(" | "))
} catch (error) { check("web pass", false, error.message) } finally { await w.close() }
model.close()
console.log(failed() ? `\n${failed()} failed` : "\nall passed")
process.exit(0)
