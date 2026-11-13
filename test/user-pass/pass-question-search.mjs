// User pass: the question tool (pick an option, type your own) and websearch (real Exa call, asked first), TUI and web.
import { check, failed, fakeModel, tempDir, tui, web, delay } from "./harness.mjs"

const toolResults = (sent) => sent.messages.filter((m) => m.role === "tool").map((m) => String(m.content))
// Turn plan: 1) ask a question  2) search the web  3) answer, quoting what it got.
const model = await fakeModel((sent) => {
  const results = toolResults(sent)
  const user = sent.messages.filter((m) => m.role === "user").at(-1)?.content ?? ""
  if (results.length === 0) {
    const multiple = /several/.test(String(user))
    return { tool: "question", args: { question: "Which runtime should the script target?", options: [{ label: "Bun (Recommended)", description: "what the repo uses" }, { label: "Node" }, { label: "Deno" }], multiple } }
  }
  if (results.length === 1) return { tool: "websearch", args: { query: "Bun 1.4 release notes", numResults: 2 } }
  return { text: "DONE answer=[" + results[0] + "] search=[" + results[1].slice(0, 120).replace(/\s+/g, " ") + "]" }
})
const project = tempDir("cg-qs-project-")

// --- TUI ---
const t = await tui({ model, cwd: project })
try {
  t.write("write a script\r")
  await t.until((s) => /Which runtime should the script target\?/.test(s), 10000, "question box")
  const box = t.screen().split("\n").filter((l) => /Which runtime|Bun \(Recommended\)|Node|Deno|Type your own|enter picks/.test(l)).slice(-6).join("\n")
  check("TUI: the question shows with its options, descriptions, and a way to type your own", /Bun \(Recommended\).*what the repo uses/.test(box) && /Type your own answer/.test(box) && /enter picks/.test(box), box)
  t.write("\x1b[B\r") // Node
  await t.until((s) => /allow websearch: "Bun 1\.4 release notes"\?/.test(s), 15000, "websearch approval")
  check("TUI: websearch asks first and shows the query", true)
  t.write("\r") // allow once
  await t.until((s) => /DONE answer=/.test(s), 40000, "final answer")
  const last = model.seen.at(-1)
  const results = toolResults(last)
  check("TUI: the picked option reaches the model", results[0] === 'The user answered "Which runtime should the script target?": "Node".', results[0])
  check("TUI: the real search returned Bun's release page", /bun/i.test(results[1] ?? "") && !/^error/.test(results[1] ?? ""), (results[1] ?? "").slice(0, 160))
  // Second prompt: type your own answer.
  t.clear(); model.seen.length = 0
  t.write("another script\r")
  await t.until((s) => /Which runtime should the script target\?/.test(s), 10000, "second question")
  t.write("\x1b[B\x1b[B\x1b[B\r") // Type your own answer
  await t.until((s) => /type your answer and press enter/.test(s), 5000, "typing mode")
  t.write("Python, actually\r")
  await t.until((s) => /allow websearch/.test(s), 10000, "second approval")
  t.write("\x1b[B\x1b[B\r") // reject the search this time
  await t.until((s) => /DONE answer=/.test(s), 15000, "second final")
  check("TUI: your own words reach the model", toolResults(model.seen.at(-1))[0] === 'The user answered "Which runtime should the script target?": "Python, actually".', toolResults(model.seen.at(-1))[0])
} catch (error) { check("TUI pass", false, error.message) } finally { t.kill() }

// --- Web ---
model.seen.length = 0
const w = await web({ model, cwd: project })
try {
  await w.send("/model local/fixture")
  await w.send("write a script, pick several", 2000)
  const q = w.page.locator(".question[data-question]").last()
  const text = (await q.innerText()).replace(/\s+/g, " ")
  check("web: the question shows inline, with checkboxes when several may be picked", /Which runtime/.test(text) && (await q.locator("input[type=checkbox]").count()) === 3 && /Send choices/.test(text), text)
  await q.locator("label.qcheck").nth(0).click(); await q.locator("label.qcheck").nth(2).click()
  await q.getByRole("button", { name: "Send choices" }).click()
  await w.page.waitForTimeout(1500)
  const prompt = w.page.locator(".permission[data-permission]").last()
  const ptext = (await prompt.innerText()).replace(/\s+/g, " ")
  check("web: websearch asks first and shows the query", /websearch/.test(ptext) && /Bun 1\.4 release notes/.test(ptext), ptext)
  await prompt.getByRole("button", { name: "Allow once" }).click()
  await w.page.waitForFunction(() => /DONE answer=/.test(document.body.innerText), null, { timeout: 40000 })
  const results = toolResults(model.seen.at(-1))
  check("web: both picks reach the model", results[0] === 'The user answered "Which runtime should the script target?": "Bun (Recommended)", "Deno".', results[0])
  check("web: the real search came back", /bun/i.test(results[1] ?? "") && !/^error/.test(results[1] ?? ""), (results[1] ?? "").slice(0, 120))
  check("web: the answered question says what was answered", /answered: Bun \(Recommended\), Deno/.test(await q.innerText()))
  // Type-your-own in the browser, then Stop mid-question expires it.
  await w.send("one more", 2000)
  const q2 = w.page.locator(".question[data-question]").last()
  await q2.locator(".qown input").fill("Zig")
  await q2.getByRole("button", { name: "Send" }).click()
  await w.page.waitForTimeout(1200)
  check("web: typed answer reaches the model", toolResults(model.seen.at(-1))[0]?.includes('"Zig"'), toolResults(model.seen.at(-1))[0])
  check("web: no console errors", w.errors.length === 0, w.errors.join(" | "))
} catch (error) { check("web pass", false, error.message) } finally { await w.close() }
model.close()
console.log(failed() ? `\n${failed()} failed` : "\nall passed")
process.exit(0)
