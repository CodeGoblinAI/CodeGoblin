// User pass: the "a newer version is out" line, in the terminal app and the web app, from the built program
// (a source checkout never checks). The registry is a stand-in on this machine; nothing real is asked.
//   bun script/build.ts && node test/user-pass/pass-update-notice.mjs
import fs from "node:fs"
import http from "node:http"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")
const names = { win32: "windows", linux: "linux", darwin: "darwin" }
process.env.CG_BIN ??= path.join(root, "dist", `codegoblin-${names[process.platform]}-${process.arch}`, "bin", process.platform === "win32" ? "codegoblin.exe" : "codegoblin")
if (!fs.existsSync(process.env.CG_BIN)) { console.log("no built program - run: bun script/build.ts"); process.exit(1) }
const { check, failed, fakeModel, tempDir, tui, web, delay } = await import("./harness.mjs")

let asked = 0
const tags = { latest: "9.9.9" }
const registry = http.createServer((request, response) => { asked++; response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ "dist-tags": tags })) })
await new Promise((resolve) => registry.listen(0, "127.0.0.1", resolve))
const extraEnv = { CODEGOBLIN_REGISTRY_URL: "http://127.0.0.1:" + registry.address().port, CODEGOBLIN_DISABLE_AUTOUPDATE: "" }
const model = await fakeModel(() => ({ text: "hello" }))
const project = tempDir("cg-update-project-")
const profile = tempDir("cg-update-profile-")
const LINE = /CodeGoblin 9\.9\.9 is out - run `codegoblin upgrade` when you want it/

{
  const t = await tui({ model, cwd: project, profile, extraEnv })
  try {
    await t.until((s) => LINE.test(s), 8000, "the notice").catch(() => {})
    check("TUI: the empty conversation says a newer version is out, and how to get it", LINE.test(t.screen()), t.screen().split("\n").filter((l) => /9\.9\.9|upgrade/.test(l)).slice(-2).join("\n") || t.screen().slice(-400))
    check("TUI: the wordmark and the composer are still there", /ask the goblin/i.test(t.screen()))
    t.write("hi\r"); await t.until((s) => /hello/.test(s), 10000, "a turn")
    t.clear(); t.write(" "); await delay(500)
    check("TUI: it is gone once the conversation starts", !LINE.test(t.screen()), t.screen().slice(-300))
  } catch (error) { check("TUI pass", false, error.message) } finally { t.kill() }
}
check("the registry was asked once", asked === 1, "asked " + asked)
{
  // Same profile, same day: answered from memory.
  const w = await web({ model, cwd: project, profile, extraEnv })
  try {
    await w.page.waitForTimeout(1500)
    const text = await w.page.locator("body").innerText()
    check("web: the page says it too", LINE.test(text), text.split("\n").filter((l) => /9\.9\.9/.test(l)).join("\n") || text.slice(-300))
    check("web: no console errors", w.errors.length === 0, w.errors.join(" | "))
  } catch (error) { check("web pass", false, error.message) } finally { await w.close() }
}
check("a second start the same day did not ask again", asked === 1, "asked " + asked)
{
  // Switched off: silent, and the registry never hears from it.
  const t = await tui({ model, cwd: project, profile: tempDir("cg-update-off-"), extraEnv: { ...extraEnv, CODEGOBLIN_DISABLE_AUTOUPDATE: "1" } })
  try {
    await delay(3000)
    check("switched off: nothing is said and nothing is asked", !LINE.test(t.screen()) && asked === 1, "asked " + asked)
  } catch (error) { check("off pass", false, error.message) } finally { t.kill() }
}
{
  // Already newest: silent.
  tags.latest = "0.0.1"
  const t = await tui({ model, cwd: project, profile: tempDir("cg-update-same-"), extraEnv })
  try {
    await delay(3000)
    check("nothing newer: it asks and says nothing", !/is out/.test(t.screen()) && asked === 2, "asked " + asked)
  } catch (error) { check("newest pass", false, error.message) } finally { t.kill() }
}
registry.close(); model.close()
console.log(failed() ? `\n${failed()} failed` : "\nall passed")
process.exit(failed() ? 1 : 0)
