// User pass: small terminals. Every screen a person meets (home, the / list, an answer with a tool row, scrolled up
// with the jump pill, the actions menu, a question, an approval, a dialog) must fit: no row wider than the window,
// no more rows than the window, and the prompt box still on screen.   SHOW=1 prints the screens.
import { check, failed, fakeModel, tempDir, tui, delay, plain } from "./harness.mjs"

const long = Array.from({ length: 30 }, (_, i) => `line ${i + 1} of a long answer that has to wrap in a narrow window`).join("\n\n")
const model = await fakeModel(async (sent) => {
  const last = sent.messages.at(-1); const text = String(last?.content ?? "")
  if (last?.role === "tool") return { text: "Done: **1 file** matched.\n\n```ts\nexport const answer = 42 // a code line long enough to need cutting in a narrow window\n```" }
  if (/question/.test(text)) return { tool: "question", args: { question: "Which runtime should the script target?", options: [{ label: "Bun (Recommended)", description: "what the repo uses" }, { label: "Node" }] } }
  if (/write/.test(text)) return { tool: "write_file", args: { path: "notes.md", content: "# Notes\n" } }
  if (/long/.test(text)) return { text: long }
  return { tool: "glob", args: { pattern: "*.md" } }
})
// A terminal cell is one column for everything this app draws except wide characters, which it does not use here.
const width = (line) => [...line].length
for (const [cols, rows] of [[80, 24], [60, 18], [44, 14]]) {
  const project = tempDir("cg-small-project-")
  const t = await tui({ model, cwd: project, cols, rows })
  const tag = `${cols}x${rows}`
  const screen = () => plain(t.out.split("\x1b[2J").at(-1)).replace(/\r/g, "").split("\n")
  const fits = (label, needsPrompt = true) => {
    const lines = screen()
    const wide = lines.filter((line) => width(line.trimEnd()) > cols)
    // The prompt box is looked for in the last two repaints: the pseudo-console sends some repaints as
    // differences, so the newest one can hold only the rows that changed.
    const recent = plain(t.out.split("\x1b[2J").slice(-2).join("\n"))
    const promptThere = /─{10,}/.test(recent)
    if (process.env.SHOW) console.log(`\n===== ${tag} ${label} =====\n` + lines.map((line) => line.trimEnd()).join("\n"))
    check(`${tag} ${label}: fits the window`, wide.length === 0 && lines.length <= rows && (!needsPrompt || promptThere), wide.length ? "too wide: " + wide[0] : lines.length > rows ? lines.length + " rows" : "")
  }
  // A finished turn, counted over everything drawn: the pseudo-console sends some repaints as differences.
  let turns = 0
  const done = async (label) => { turns++; await t.until((all) => (all.match(/worked for/g) ?? []).length >= turns, 10000, label) }
  try {
    await delay(800); fits("home")
    t.write("/mo"); await delay(500); fits("the / list"); t.write("\x15"); await delay(200)
    t.write("find the notes\r"); await done("answer"); await delay(300); fits("an answer with a tool row")
    t.write("a long one\r"); await delay(600); await t.until(() => !/esc twice/.test(screen().join("\n")), 10000, "long answer"); await delay(300)
    t.write("\x1b[5~"); await delay(400); fits("scrolled up")
    check(`${tag} scrolled up: the jump pill shows`, /Jump to bottom|ctrl\+end/.test(screen().join("\n")))
    t.write("\x1b[1;5F"); await delay(300)
    t.write("\x07"); await delay(500); fits("the actions menu", false); t.write("\x1b"); await delay(300)
    t.write("/search\r"); await delay(500); t.write("line 2"); await delay(400); fits("conversation search", false); t.write("\x1b"); await delay(300)
    t.write("/model\r"); await delay(700); fits("the model picker", false); t.write("\x1b"); await delay(300); t.write("\x15"); await delay(200)
    t.write("/status\r"); await delay(500); fits("status", false); t.write("\x1b"); await delay(300)
    t.write("ask me a question\r"); await t.until(() => /Which runtime/.test(screen().join("\n")), 10000, "question"); await delay(300); fits("a question")
    t.write("1"); await delay(1200)
    t.write("write the notes\r"); await t.until(() => /Allow once/.test(screen().join("\n")), 10000, "approval"); await delay(300); fits("an approval")
    t.write("\x1b"); await delay(600)
  } catch (error) { check(tag + " pass", false, error.message) } finally { t.kill() }
}
model.close()
console.log(failed() ? `\n${failed()} failed` : "\nall passed")
process.exit(0)
