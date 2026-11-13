// User pass: "formatter" in codegoblin.jsonc formats what the model writes (real prettier), TUI and web.
import fs from "node:fs"
import path from "node:path"
import { check, failed, fakeModel, tempDir, tui, web, delay } from "./harness.mjs"

const PRETTIER = "C:/Users/shawn/code/CodeGoblin/node_modules/.bin/prettier.exe"
const messy = "const   a={b:1,c:[1,2,3]}\nfunction f( x ){return x*2}\n"
const tidy = "const a = { b: 1, c: [1, 2, 3] };\nfunction f(x) {\n  return x * 2;\n}\n"
const lastResults = []
const model = await fakeModel((sent) => {
  const lastUser = sent.messages.map((m) => m.role).lastIndexOf("user")
  const results = sent.messages.slice(lastUser + 1).filter((m) => m.role === "tool")
  if (results.length) { lastResults.push(String(results[0].content)); return { text: "Wrote it." } }
  return { tool: "write_file", args: { path: "src/messy.ts", content: messy } }
})
function profileWithFormatter() {
  const profile = tempDir("cg-fmt-profile-")
  fs.mkdirSync(path.join(profile, "config"), { recursive: true })
  fs.writeFileSync(path.join(profile, "config", "codegoblin.jsonc"), JSON.stringify({ formatter: { prettier: { command: [PRETTIER, "--write", "$FILE"], extensions: [".ts"] } } }, null, 2))
  return profile
}

// --- TUI ---
{
  const project = tempDir("cg-fmt-project-")
  const t = await tui({ model, cwd: project, profile: profileWithFormatter() })
  try {
    t.write("\x1b[Z"); await delay(300)
    t.write("write a messy file\r")
    await t.until((s) => /Wrote it\./.test(s), 20000, "turn")
    check("TUI: the written file was formatted with prettier", fs.readFileSync(path.join(project, "src", "messy.ts"), "utf8") === tidy, fs.readFileSync(path.join(project, "src", "messy.ts"), "utf8"))
    check("TUI: the model was told", /formatted with prettier/.test(lastResults.at(-1) ?? ""), lastResults.at(-1))
    t.clear(); t.write("/undo\r"); await delay(900)
    check("TUI: /undo takes back the write and the formatting together", !fs.existsSync(path.join(project, "src", "messy.ts")), t.screen().split("\n").filter((l) => /undid|undo/.test(l)).slice(-1).join(""))
  } catch (error) { check("TUI pass", false, error.message) } finally { t.kill() }
}

// --- Web ---
{
  const project = tempDir("cg-fmt-web-project-")
  const w = await web({ model, cwd: project, profile: profileWithFormatter() })
  try {
    await w.page.click("#mode-btn"); await w.page.waitForTimeout(300)
    await w.page.getByText("Approve for me", { exact: false }).first().click(); await w.page.waitForTimeout(300)
    await w.send("write a messy file", 4000)
    check("web: the written file was formatted with prettier", fs.readFileSync(path.join(project, "src", "messy.ts"), "utf8") === tidy)
    check("web: the model was told", /formatted with prettier/.test(lastResults.at(-1) ?? ""), lastResults.at(-1))
    check("web: no console errors", w.errors.length === 0, w.errors.join(" | "))
  } catch (error) { check("web pass", false, error.message) } finally { await w.close() }
}
// Without the setting, nothing is formatted.
{
  const project = tempDir("cg-fmt-off-project-")
  const t = await tui({ model, cwd: project })
  try {
    t.write("\x1b[Z"); await delay(300)
    t.write("write a messy file\r")
    await t.until((s) => /Wrote it\./.test(s), 20000, "turn")
    check("TUI: with no formatter setting the file stays as written", fs.readFileSync(path.join(project, "src", "messy.ts"), "utf8") === messy)
  } catch (error) { check("TUI off pass", false, error.message) } finally { t.kill() }
}
model.close()
console.log(failed() ? `\n${failed()} failed` : "\nall passed")
process.exit(0)
