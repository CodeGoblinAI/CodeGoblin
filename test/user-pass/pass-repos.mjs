// User pass: repo_clone (real shallow clone of a tiny public repo), repo_overview and reading it - TUI and web.
import { check, failed, fakeModel, tempDir, tui, web, delay } from "./harness.mjs"

const results = () => last
let last = []
const model = await fakeModel((sent) => {
  const lastUser = sent.messages.map((m) => m.role).lastIndexOf("user")
  const done = sent.messages.slice(lastUser + 1).filter((m) => m.role === "tool").map((m) => String(m.content))
  last = done
  if (done.length === 0) return { tool: "repo_clone", args: { repository: "octocat/Hello-World" } }
  if (done.length === 1) {
    const folder = (done[0].match(/: (.+)$/) ?? [])[1]?.trim()
    return { tools: [{ name: "repo_overview", args: { target: "octocat/Hello-World" } }, { name: "read_file", args: { path: folder + "\\README" } }] }
  }
  return { text: "Read it." }
})
const project = tempDir("cg-repos-project-")

// --- TUI ---
{
  const t = await tui({ model, cwd: project })
  try {
    t.write("how does Hello-World greet?\r")
    await t.until((s) => /allow repo_clone: octocat\/Hello-World\?/.test(s), 10000, "clone asks")
    check("TUI: repo_clone asks, naming the repository", true)
    t.write("\r")
    await t.until((s) => /Read it\./.test(s), 60000, "done")
    const [cloned, overview, readme] = results()
    check("TUI: the real clone lands in CG-Next's own folder, not the project", /^cloned: .*[\\/]data[\\/]repos[\\/]github\.com[\\/]octocat[\\/]Hello-World$/.test(cloned ?? ""), cloned)
    check("TUI: repo_overview describes it", /layout:/.test(overview ?? "") && /README/.test(overview ?? ""), (overview ?? "").slice(0, 160))
    check("TUI: read_file reads the cloned README", /Hello World/i.test(readme ?? ""), (readme ?? "").slice(0, 80))
  } catch (error) { check("TUI pass", false, error.message) } finally { t.kill() }
}

// --- Web ---
{
  const w = await web({ model, cwd: project })
  try {
    await w.send("how does Hello-World greet?", 2000)
    const prompt = w.page.locator(".permission[data-permission]").last()
    check("web: repo_clone asks, naming the repository", /repo_clone/.test(await prompt.innerText()) && /octocat\/Hello-World/.test(await prompt.innerText()))
    await prompt.getByRole("button", { name: "Allow once" }).click()
    await w.page.waitForFunction(() => /Read it\./.test(document.body.innerText), null, { timeout: 60000 })
    check("web: clone, overview and read all worked", /^cloned: /.test(results()[0] ?? "") && /Hello World/i.test(results()[2] ?? ""), results().map((r) => r.slice(0, 60)).join(" | "))
    check("web: no console errors", w.errors.length === 0, w.errors.join(" | "))
  } catch (error) { check("web pass", false, error.message) } finally { await w.close() }
}
model.close()
console.log(failed() ? `\n${failed()} failed` : "\nall passed")
process.exit(0)
