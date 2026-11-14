// User pass: the TUI's [Model] toolbar dialog shows Favourites/Recent headings and ctrl+f stars the highlighted row.
import { check, failed, fakeModel, tempDir, tui, delay, plain } from "./harness.mjs"
const model = await fakeModel(() => ({ text: "hi" }))
const project = tempDir("cg-favdlg-project-")
const t = await tui({ model, cwd: project, rows: 46 })
try {
  // Click [Model] where the toolbar is actually drawn - under the composer on the home screen,
  // at the bottom in a conversation - found in the last repaint.
  const frame = plain(t.out.split("\x1b[2J").at(-1)).replace(/\r/g, "").split("\n")
  const row = frame.findIndex((line) => line.includes("[Model]"))
  const col = frame[row].indexOf("[Model]") + 3
  t.write(`\x1b[<0;${col};${row + 1}M`); t.write(`\x1b[<0;${col};${row + 1}m`); await delay(600)
  const opened = t.screen()
  check("TUI: clicking [Model] opens the picker with the ctrl+f hint", /Choose model/.test(opened) && /ctrl\+f favourite/.test(opened), opened.split("\n").filter((l) => /Choose model|ctrl\+f/.test(l)).join("\n"))
  t.write("\x06"); await delay(900) // ctrl+f
  const after = t.screen()
  const tail = after.slice(after.lastIndexOf("Choose model"))
  check("TUI: ctrl+f stars the highlighted model and the list grows a Favourites heading", /FAVOURITES|Favourites/.test(tail) && /★/.test(tail), tail.split("\n").filter((l) => /Favourites|★|Text models/i.test(l)).slice(0, 4).join("\n"))
  check("TUI: the status line says so", /★ favourite: /.test(after))
  t.write("\x06"); await delay(900)
  const again = t.screen()
  check("TUI: ctrl+f again unstars it", /no longer a favourite: /.test(again))
  // The picker can be searched: typing narrows it.
  t.write("flash"); await delay(500)
  const searched = plain(t.out.split("\x1b[2J").at(-1))
  check("TUI: typing in the picker narrows it to matching models", /⌕ flash/.test(searched) && /Flash/.test(searched) && !/GPT-5\.6 /.test(searched))
} catch (error) { check("TUI dialog pass", false, error.message) } finally { t.kill() }
model.close()
console.log(failed() ? `\n${failed()} failed` : "\nall passed")
process.exit(0)
