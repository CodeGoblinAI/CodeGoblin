// User pass: apply_patch from a (fake) Codex-family model in the TUI and web; delete asks in approve mode; /undo.
import fs from "node:fs"
import path from "node:path"
import { check, failed, fakeModel, tempDir, tui, web, delay } from "./harness.mjs"

const thePatch = ["*** Begin Patch", "*** Update File: app.py", "@@ def greet():", '-    print("Hi")', '+    print("Hello, world!")', "*** Delete File: old.txt", "*** End Patch"].join("\n")
let offered = []
const model = await fakeModel((sent) => {
  offered = (sent.tools ?? []).map((t) => t.function.name)
  const lastUser = sent.messages.map((m) => m.role).lastIndexOf("user")
  const results = sent.messages.slice(lastUser + 1).filter((m) => m.role === "tool")
  return results.length ? { text: "Patched: " + results[0].content.replace(/\n/g, " / ") } : { tool: "apply_patch", args: { patch: thePatch } }
}, "gpt-5.2-codex-fixture")
const setup = () => {
  const root = tempDir("cg-patch-project-")
  fs.writeFileSync(path.join(root, "app.py"), 'def greet():\n    print("Hi")\n')
  fs.writeFileSync(path.join(root, "old.txt"), "obsolete\n")
  return root
}
const env = { CODEGOBLIN_LOCAL_MODEL: "gpt-5.2-codex-fixture" }

// --- TUI ---
{
  const project = setup()
  const t = await tui({ model, cwd: project, extraEnv: env })
  try {
    t.write("\x1b[Z"); await delay(300) // approve for me
    t.write("tidy the greeting\r")
    await t.until((s) => /allow apply_patch: deletes or moves files: app\.py, old\.txt\?/.test(s), 10000, "delete asks")
    check("TUI: a Codex-family model is offered apply_patch", offered.includes("apply_patch"), offered.join(","))
    check("TUI: in approve mode, a patch that deletes still asks and names the files", true)
    t.write("\r")
    await t.until((s) => /Patched:/.test(s), 10000, "result")
    check("TUI: the patch applied", fs.readFileSync(path.join(project, "app.py"), "utf8").includes("Hello, world!") && !fs.existsSync(path.join(project, "old.txt")))
    t.clear(); t.write("/undo\r"); await delay(900)
    check("TUI: /undo brings both files back", fs.readFileSync(path.join(project, "app.py"), "utf8").includes('print("Hi")') && fs.existsSync(path.join(project, "old.txt")), t.screen().split("\n").filter((l) => /undid/.test(l)).slice(-1).join(""))
  } catch (error) { check("TUI pass", false, error.message) } finally { t.kill() }
}

// --- Web ---
{
  const project = setup()
  const w = await web({ model, cwd: project, extraEnv: env })
  try {
    await w.send("tidy the greeting", 2000)
    const prompt = w.page.locator(".permission[data-permission]").last()
    const text = (await prompt.innerText()).replace(/\s+/g, " ")
    check("web: the prompt names what the patch touches", /apply_patch/.test(text) && /deletes or moves files: app\.py, old\.txt/.test(text), text)
    await prompt.getByRole("button", { name: "Allow once" }).click(); await w.page.waitForTimeout(1500)
    check("web: the patch applied", fs.readFileSync(path.join(project, "app.py"), "utf8").includes("Hello, world!") && !fs.existsSync(path.join(project, "old.txt")))
    check("web: no console errors", w.errors.length === 0, w.errors.join(" | "))
  } catch (error) { check("web pass", false, error.message) } finally { await w.close() }
}
model.close()
console.log(failed() ? `\n${failed()} failed` : "\nall passed")
process.exit(0)
