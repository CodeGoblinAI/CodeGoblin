// User pass: /import antigravity and /import cursor in the TUI and the web, against fixture stores.
import path from "node:path"
import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { check, failed, fakeModel, tempDir, tui, web, delay } from "./harness.mjs"
const here = path.dirname(fileURLToPath(import.meta.url))
const base = tempDir("cg-ide-fixtures-")
const project = tempDir("cg-ide-project-")
execFileSync("bun", [path.join(here, "make-ide-fixtures.ts"), base, project])
const extraEnv = { CG_ANTIGRAVITY_DIR: path.join(base, "antigravity"), CG_CURSOR_CHATS_DIR: path.join(base, "cursor"), CG_FORK_DB: path.join(base, "codegoblin.db") }
let lastMessages = []
const model = await fakeModel((sent) => { lastMessages = sent.messages; return { text: "continuing" } })

// --- TUI ---
{
  const t = await tui({ model, cwd: project, extraEnv })
  try {
    t.write("/import cursor\r"); await delay(1500)
    check("TUI: /import cursor lists this project's Cursor chat", /Rename button/.test(t.screen()), t.screen().split("\n").filter((l) => /Rename|Cursor/.test(l)).slice(-3).join("\n"))
    t.write("\r"); await delay(800)
    t.write("\r"); await delay(1500)
    const screen = t.screen()
    check("TUI: importing it opens the copy with what was said", /rename the button/.test(screen) && /Renamed it to Save\./.test(screen) && !/<user_query>/.test(screen), screen.split("\n").filter((l) => /rename|Renamed|Imported/i.test(l)).slice(-4).join("\n"))
    t.write("and the other button?\r"); await t.until((s) => /continuing/.test(s), 10000, "continue")
    check("TUI: the conversation carries on from the copy", lastMessages.some((m) => m.role === "assistant" && m.content === "Renamed it to Save."))
  } catch (error) { check("TUI pass", false, error.message) } finally { t.kill() }
}

// --- Web ---
{
  const w = await web({ model, cwd: project, extraEnv })
  try {
    await w.send("/import antigravity", 1500)
    const dialog = w.page.locator("dialog")
    check("web: /import antigravity lists the conversation and says what is left out", /Plan the release/.test(await dialog.innerText()) && /search index/.test(await dialog.innerText()), (await dialog.innerText()).slice(0, 200))
    await dialog.getByText("Plan the release").first().click(); await w.page.waitForTimeout(400)
    await dialog.getByRole("button", { name: "Copy as new conversation" }).click(); await w.page.waitForTimeout(2000)
    const thread = await w.thread()
    check("web: the copy opens with both turns", /when do we ship\?/.test(thread) && /Friday, after the tests pass\./.test(thread), thread.slice(-200))
    check("web: no console errors", w.errors.length === 0, w.errors.join(" | "))
  } catch (error) { check("web pass", false, error.message) } finally { await w.close() }
}
// --- CodeGoblin 0.3, in both ---
{
  const t = await tui({ model, cwd: project, extraEnv })
  try {
    t.write("/import codegoblin\r"); await delay(1500)
    check("TUI: /import codegoblin lists this project's 0.3 conversation", /Speed up the build/.test(t.screen()), t.screen().split("\n").filter((l) => /Speed|CodeGoblin/.test(l)).slice(-3).join("\n"))
    t.write("\r"); await delay(800)
    check("TUI: it says in full what is left out, and that 0.3 keeps its copy", /What was said only - tool calls and output, reasoning and images omitted/.test(t.screen()) && /Source untouched/.test(t.screen()), t.screen().split("\n").filter((l) => /omitted|untouched/.test(l)).slice(-2).join("\n"))
    t.write("\r"); await delay(1500)
    const screen = t.screen()
    check("TUI: the copy opens with what was said and none of the tool output or thinking", /why is the build slow\?/.test(screen) && /I removed one pass\./.test(screen) && !/hidden/.test(screen), screen.split("\n").filter((l) => /build|pass|hidden|Imported/i.test(l)).slice(-4).join("\n"))
    t.write("anything else slow?\r"); await t.until((s) => /continuing/.test(s), 10000, "continue")
    check("TUI: the conversation carries on from the copy", lastMessages.some((m) => m.role === "assistant" && m.content === "It bundles twice; I removed one pass."))
  } catch (error) { check("TUI 0.3 pass", false, error.message) } finally { t.kill() }
  const w = await web({ model, cwd: project, extraEnv })
  try {
    await w.send("/import old", 1500)
    const dialog = w.page.locator("dialog")
    check("web: /import old lists it under CodeGoblin 0.3", /Speed up the build/.test(await dialog.innerText()) && /CodeGoblin 0\.3/.test(await dialog.innerText()), (await dialog.innerText()).slice(0, 200))
    await dialog.getByText("Speed up the build").first().click(); await w.page.waitForTimeout(400)
    await dialog.getByRole("button", { name: "Copy as new conversation" }).click(); await w.page.waitForTimeout(2000)
    const thread = await w.thread()
    check("web: the copy opens with the question and the answer only", /why is the build slow\?/.test(thread) && /I removed one pass\./.test(thread) && !/hidden/.test(thread), thread.slice(-200))
    check("web: no console errors", w.errors.length === 0, w.errors.join(" | "))
  } catch (error) { check("web 0.3 pass", false, error.message) } finally { await w.close() }
}
model.close()
console.log(failed() ? `\n${failed()} failed` : "\nall passed")
process.exit(0)
