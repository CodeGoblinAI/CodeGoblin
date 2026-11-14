// User pass: the terminal's home screen - centred wordmark, tip, folder:branch - at two sizes, then a prompt.
import fs from "node:fs"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { check, failed, fakeModel, tempDir, tui, delay, plain } from "./harness.mjs"
const model = await fakeModel(() => ({ text: "ok then" }))
const project = tempDir("cg-home-project-")
execFileSync("git", ["init", "-q", "-b", "spike", project])
fs.writeFileSync(path.join(project, "README.md"), "# demo\n")
/** The last full repaint, as rows of text. */
const frame = (t) => plain(t.out.split("\x1b[2J").at(-1)).replace(/\r/g, "").split("\n")
for (const [cols, rows] of [[120, 36], [70, 20]]) {
  const t = await tui({ model, cwd: project, cols, rows })
  try {
    await delay(1500)
    const lines = frame(t)
    console.log("--- " + cols + "x" + rows + " ---\n" + lines.join("\n"))
    const art = lines.findIndex((l) => /██|C O D E G O B L I N/.test(l))
    const box = lines.findIndex((l) => /ask the goblin anything/.test(l))
    check(cols + "x" + rows + ": the wordmark sits in the middle of the space above the composer", art > 2 && box - art > 5, "art row " + art + ", composer row " + box)
    check(cols + "x" + rows + ": the tip and the folder with its branch are shown", lines.some((l) => /\/ for commands/.test(l)) && lines.some((l) => /cg-home-project-.*:spike/.test(l)))
    check(cols + "x" + rows + ": the composer is ruled with line characters, and nothing overflows", lines.some((l) => /─{20}/.test(l)) && lines.length <= rows && lines.every((l) => [...l].length <= cols), lines.length + " rows; widest " + Math.max(...lines.map((l) => [...l].length)) + "; ruled " + lines.some((l) => /─{20}/.test(l)))
    if (cols === 120) {
      t.write("hello\r"); await t.until((s) => /ok then/.test(s), 10000, "answer"); await delay(600)
      check("after a prompt the home screen gives way to the conversation", !/\/ for commands {2}/.test(frame(t).join("\n")) && /ok then/.test(frame(t).join("\n")))
    }
  } catch (error) { check("TUI home " + cols, false, error.message) } finally { t.kill() }
}
model.close()
console.log(failed() ? `\n${failed()} failed` : "\nall passed")
process.exit(0)
