// User pass: "Never for this session" in the TUI and the web.
import { check, failed, fakeModel, tempDir, tui, web, delay } from "./harness.mjs"

// The model asks to push, then (after the refusal) asks again, then answers.
const model = await fakeModel((sent) => {
  const tools = sent.messages.filter((m) => m.role === "tool")
  if (tools.length === 0) return { tool: "shell", args: { command: "git push origin main" } }
  if (tools.length === 1) return { tool: "shell", args: { command: "git push --force" } }
  return { text: "Not pushing: " + tools.map((t) => t.content).join(" / ") }
})
const project = tempDir("cg-never-project-")

// --- TUI ---
const t = await tui({ model, cwd: project })
try {
  t.write("push it\r")
  await t.until((s) => /allow shell: git push origin main/.test(s), 10000, "first prompt")
  const box = t.screen().split("\n").filter((l) => /Allow|Reject|Never|allow shell/.test(l)).slice(-5).join("\n")
  check("TUI: the prompt offers Never for this session, naming what it covers", /Never for this session/.test(box) && /refuse "git push" without asking/.test(box), box)
  t.write("\x1b[B\x1b[B\x1b[B\r")
  await t.until((s) => /Not pushing:/.test(s), 10000, "answer")
  await delay(500)
  const second = model.seen.at(-1).messages.filter((m) => m.role === "tool").map((m) => m.content)
  check("TUI: the second push is refused without a second prompt", (t.screen().match(/allow shell: git push/g) ?? []).length === 1 && /said never to "git push"/.test(second[1] ?? ""), second.join(" | "))
  t.clear(); t.write("/status\r"); await delay(900)
  check("TUI: /status lists what was answered never", /never shell:git push/.test(t.screen()), t.screen().split("\n").filter((l) => /approved|never/.test(l)).join("\n"))
} catch (error) { check("TUI pass", false, error.message) } finally { t.kill() }

// --- Web ---
model.seen.length = 0
const w = await web({ model, cwd: project })
try {
  await w.send("/model local/fixture")
  await w.send("push it", 2000)
  const prompt = w.page.locator(".permission[data-permission]").last()
  const buttons = await prompt.locator("button").allInnerTexts()
  check("web: the prompt has four answers, Never last", buttons.join("|") === "Allow once|Allow for this session|Reject|Never for this session", buttons.join("|"))
  check("web: Never's tooltip names what it covers", (await prompt.getByRole("button", { name: "Never for this session" }).getAttribute("title")) === 'refuse "git push" without asking')
  await prompt.getByRole("button", { name: "Never for this session" }).click()
  await w.page.waitForTimeout(2000)
  const prompts = await w.page.locator(".permission[data-permission]").count()
  const thread = await w.thread()
  check("web: only one prompt was shown and the model was told", prompts === 1 && /Not pushing:/.test(thread) && /said never/.test(thread), `${prompts} prompts; ${thread.slice(-260)}`)
  check("web: the answered prompt says never", /never for this session/.test(await prompt.innerText()))
  check("web: no console errors", w.errors.length === 0, w.errors.join(" | "))
} catch (error) { check("web pass", false, error.message) } finally { await w.close() }
model.close()
console.log(failed() ? `\n${failed()} failed` : "\nall passed")
process.exit(0)
