// User pass: undo survives a restart. A fake model writes a file; the app is closed and reopened,
// the conversation resumed, and /undo puts the file back. TUI, then web (server restarted).
import fs from "node:fs"
import path from "node:path"
import { check, failed, fakeModel, tempDir, tui, web, delay } from "./harness.mjs"

const model = await fakeModel((sent) => {
  const lastUser = sent.messages.map((m) => m.role).lastIndexOf("user")
  const done = sent.messages.slice(lastUser + 1).some((m) => m.role === "tool")
  return done ? { text: "Wrote it." } : { tool: "write_file", args: { path: "notes.txt", content: "written by the model\n" } }
})

// --- TUI ---
{
  const project = tempDir("cg-undo-project-")
  fs.writeFileSync(path.join(project, "notes.txt"), "my original notes\n")
  const profile = tempDir("cg-undo-profile-")
  let t = await tui({ model, cwd: project, profile })
  try {
    t.write("\x1b[Z"); await delay(400) // approve for me: edits run without asking
    t.write("rewrite my notes\r")
    await t.until((s) => /Wrote it\./.test(s), 15000, "turn")
    check("TUI: the model's write landed", fs.readFileSync(path.join(project, "notes.txt"), "utf8") === "written by the model\n")
    await delay(800)
  } finally { t.kill() }
  await delay(800)
  t = await tui({ model, cwd: project, profile })
  try {
    t.write("/undo\r"); await delay(800)
    check("TUI: a fresh start with no conversation open has nothing to undo", /nothing to undo/.test(t.screen()), t.screen().split("\n").filter((l) => /undo/.test(l)).slice(-1).join(""))
    t.clear(); t.write("/resume\r"); await delay(1200)
    await t.until((s) => /rewrite my notes/.test(s), 8000, "session list")
    t.write("\r"); await delay(1200)
    t.clear(); t.write("/undo\r"); await delay(1000)
    const line = t.screen().split("\n").filter((l) => /undid|undo failed|nothing/.test(l)).slice(-1).join("")
    check("TUI: after restart and resume, /undo puts the file back", fs.readFileSync(path.join(project, "notes.txt"), "utf8") === "my original notes\n" && /undid 1 file \(notes\.txt\)/.test(line), line)
    t.clear(); t.write("/redo\r"); await delay(1000)
    check("TUI: and /redo reapplies it", fs.readFileSync(path.join(project, "notes.txt"), "utf8") === "written by the model\n")
    // Hand-edit, then undo must refuse.
    fs.writeFileSync(path.join(project, "notes.txt"), "I changed this myself\n")
    t.clear(); t.write("/undo\r"); await delay(1000)
    check("TUI: a hand edit since the turn is never overwritten", fs.readFileSync(path.join(project, "notes.txt"), "utf8") === "I changed this myself\n" && /changed since that turn/.test(t.screen()), t.screen().split("\n").filter((l) => /undo/.test(l)).slice(-1).join(""))
  } catch (error) { check("TUI pass", false, error.message) } finally { t.kill() }
}

// --- Web ---
{
  const project = tempDir("cg-undo-web-project-")
  fs.writeFileSync(path.join(project, "notes.txt"), "my original notes\n")
  const profile = tempDir("cg-undo-web-profile-")
  let w = await web({ model, cwd: project, profile })
  let sessionId = ""
  try {
    await w.page.click("#mode-btn"); await w.page.waitForTimeout(300)
    await w.page.getByText("Approve for me", { exact: false }).first().click(); await w.page.waitForTimeout(300)
    await w.send("rewrite my notes", 2500)
    check("web: the model's write landed", fs.readFileSync(path.join(project, "notes.txt"), "utf8") === "written by the model\n")
    sessionId = await w.page.evaluate(() => (typeof sessionId !== "undefined" ? sessionId : "") || "")
  } catch (error) { check("web first half", false, error.message) } finally { await w.close() }
  await delay(800)
  w = await web({ model, cwd: project, profile })
  try {
    // Open the conversation from the sidebar's session list.
    await w.send("/resume ", 800)
    const item = w.page.locator(".palette > *").filter({ hasText: "rewrite my notes" }).first()
    await item.click(); await w.page.waitForTimeout(1500)
    await w.send("/undo", 1500)
    const note = await w.note()
    check("web: after a server restart and resume, /undo puts the file back", fs.readFileSync(path.join(project, "notes.txt"), "utf8") === "my original notes\n" && /undid 1 file/.test(note), note)
    check("web: no console errors", w.errors.length === 0, w.errors.join(" | "))
  } catch (error) { check("web pass", false, error.message) } finally { await w.close() }
}
model.close()
console.log(failed() ? `\n${failed()} failed` : "\nall passed")
process.exit(0)
