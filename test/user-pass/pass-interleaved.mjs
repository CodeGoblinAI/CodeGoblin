// User pass: a provider that sends reasoning, some answer, a sliver more reasoning, then the rest of the answer
// (seen live from DeepSeek V4.1 Flash via Experiential Labs) must show ONE reasoning block and ONE answer.
import { check, failed, fakeModel, tempDir, tui, web, delay, plain } from "./harness.mjs"
const model = await fakeModel(() => ({ stream: [
  { reasoning: "The user is just testing." },
  { text: "All" },
  { reasoning: " " },
  { text: " good on my end - tools, shell, and files are ready." },
] }))
const project = tempDir("cg-interleave-project-")

// --- TUI ---
{
  const t = await tui({ model, cwd: project })
  try {
    t.write("just testing\r")
    await t.until((s) => /files are ready/.test(s), 10000, "answer")
    await delay(500)
    const frame = plain(t.out.split("\x1b[2J").at(-1))
    const answers = (frame.match(/^\s*local server\s*$/gm) ?? []).length
    const thoughts = (frame.match(/thought for/g) ?? []).length
    check("TUI: one answer, not two", answers === 1, answers + " answer headings")
    check("TUI: one reasoning line", thoughts === 1, thoughts + " thought lines")
    check("TUI: the answer reads as one sentence", /All good on my end/.test(frame.replace(/\s*\|\s*/g, " ")))
  } catch (error) { check("TUI pass", false, error.message) } finally { t.kill() }
}

// --- Web ---
{
  const w = await web({ model, cwd: project })
  try {
    await w.send("just testing", 2000)
    const answers = await w.page.locator(".turn.agent").count()
    const thinking = await w.page.locator(".thinking").count()
    const order = await w.page.evaluate(() => [...document.querySelectorAll("#thread > .thinking, #thread > .turn.agent")].map((el) => el.className.includes("thinking") ? "thinking" : "answer"))
    check("web: one answer and one reasoning box, reasoning above", answers === 1 && thinking === 1 && order.join(",") === "thinking,answer", JSON.stringify({ answers, thinking, order }))
    check("web: the answer reads as one sentence", /All good on my end/.test(await w.page.locator(".turn.agent .body").innerText()))
    check("web: no console errors", w.errors.length === 0, w.errors.join(" | "))
  } catch (error) { check("web pass", false, error.message) } finally { await w.close() }
}
model.close()
console.log(failed() ? `\n${failed()} failed` : "\nall passed")
process.exit(0)
