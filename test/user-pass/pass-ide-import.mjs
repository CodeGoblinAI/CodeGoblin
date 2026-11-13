// User pass: /import antigravity and /import cursor in the TUI and the web, against fixture stores.
import path from "node:path"
import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { check, failed, fakeModel, tempDir, tui, web, delay } from "./harness.mjs"
const here = path.dirname(fileURLToPath(import.meta.url))
const base = tempDir("cg-ide-fixtures-")
const project = tempDir("cg-ide-project-")
execFileSync("bun", [path.join(here, "make-ide-fixtures.ts"), base, project])
const extraEnv = { CG_ANTIGRAVITY_DIR: path.join(base, "antigravity"), CG_CURSOR_CHATS_DIR: path.join(base, "cursor") }
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
model.close()
console.log(failed() ? `\n${failed()} failed` : "\nall passed")
process.exit(0)
