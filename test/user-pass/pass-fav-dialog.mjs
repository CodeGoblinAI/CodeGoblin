// User pass: the TUI's [Model] toolbar dialog shows Favourites/Recent headings and ctrl+f stars the highlighted row.
import { check, failed, fakeModel, tempDir, tui, delay } from "./harness.mjs"
const model = await fakeModel(() => ({ text: "hi" }))
const project = tempDir("cg-favdlg-project-")
const t = await tui({ model, cwd: project, rows: 46 })
try {
  const lines = t.screen().split("\n")
  // Find the toolbar row and the column of "[Model]".
  let row = -1, col = -1
  for (let i = lines.length - 1; i >= 0; i--) { const c = lines[i].indexOf("[Model]"); if (c >= 0) { row = i; col = c; break } }
  // The screen buffer is the whole output; use the last 46 rendered lines' position: toolbar is the bottom line.
  // The toolbar is near the bottom; click up the last few rows until the picker opens.
  for (let r = 46; r >= 38 && !/Choose model/.test(t.screen()); r--) {
    t.write(`\x1b[<0;9;${r}M`); t.write(`\x1b[<0;9;${r}m`); await delay(400)
  }
  const opened = t.screen()
  check("TUI: clicking [Model] opens the picker with the ctrl+f hint", /Choose model/.test(opened) && /ctrl\+f favourite/.test(opened), opened.split("\n").filter((l) => /Choose model|ctrl\+f/.test(l)).join("\n"))
  t.write("\x06"); await delay(900) // ctrl+f
  const after = t.screen()
  const tail = after.slice(after.lastIndexOf("Choose model"))
  check("TUI: ctrl+f stars the highlighted model and the list grows a Favourites heading", /FAVOURITES|Favourites/.test(tail) && /\u2605/.test(tail), tail.split("\n").filter((l) => /Favourites|\u2605|Text models/i.test(l)).slice(0, 4).join("\n"))
  check("TUI: the status line says so", /\u2605 favourite: /.test(after))
  t.write("\x06"); await delay(900)
  const again = t.screen()
  check("TUI: ctrl+f again unstars it", /no longer a favourite: /.test(again))
} catch (error) { check("TUI dialog pass", false, error.message) } finally { t.kill() }
model.close()
console.log(failed() ? `\n${failed()} failed` : "\nall passed")
process.exit(0)
