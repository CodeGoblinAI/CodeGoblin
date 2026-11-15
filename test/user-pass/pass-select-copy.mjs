// User pass, terminal: the three things a person does without thinking.
// 1. Drag over text in the conversation: it is highlighted, and letting go copies it (checked on the real clipboard).
// 2. A pasted picture can be taken off again: backspace at the start of the prompt.
// 3. Closing the app and opening it again comes back on the model used last, not the built-in default.
import fs from "node:fs"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { check, failed, fakeModel, tempDir, tui, delay, plain } from "./harness.mjs"

const model = await fakeModel(() => ({ text: "The quick brown fox jumps over the lazy dog.\n\nSecond paragraph, with `code` in it." }))
const screenOf = (t) => plain(t.out.split("\x1b[2J").at(-1)).replace(/\r/g, "")
const rawOf = (t) => t.out.split("\x1b[2J").at(-1)
const waitFor = async (t, pattern, ms = 15000) => { for (let waited = 0; waited < ms; waited += 200) { if (pattern.test(screenOf(t))) return true; await delay(200) } return false }
const clipboard = () => process.platform === "win32" ? execFileSync("powershell.exe", ["-NoProfile", "-Command", "Get-Clipboard -Raw"], { encoding: "utf8" }).replace(/\r/g, "").trimEnd() : ""
const setClipboard = (text) => { if (process.platform === "win32" && text) execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Set-Clipboard -Value ([Console]::In.ReadToEnd())"], { input: text }) }
/** Where a piece of text is on the screen, 1-based. */
const find = (t, text) => { const rows = screenOf(t).split("\n"); const row = rows.findIndex((line) => line.includes(text)); return row < 0 ? undefined : { row: row + 1, col: rows[row].indexOf(text) + 1 } }
const mouse = (t, kind, col, row) => t.write(`\x1b[<${kind === "drag" ? 32 : 0};${col};${row}${kind === "up" ? "m" : "M"}`)

const profile = tempDir("cg-pass-profile-")
const project = tempDir("cg-select-project-")
const before = process.platform === "win32" ? clipboard() : ""
let t = await tui({ model, cwd: project, profile, cols: 110, rows: 30 })
try {
  await waitFor(t, /ask · /)
  t.write("say something\r"); await waitFor(t, /Second paragraph/); await delay(500)

  // --- drag to select ---
  const from = find(t, "quick brown"), to = find(t, "lazy dog")
  check("the answer is on screen", Boolean(from && to), screenOf(t).slice(0, 400))
  mouse(t, "down", from.col, from.row); await delay(80)
  for (let col = from.col + 4; col < to.col + 7; col += 6) { mouse(t, "drag", col, from.row); await delay(30) }
  mouse(t, "drag", to.col + 7, to.row); await delay(300)
  const during = rawOf(t)
  check("dragging highlights the text under it", /48;2;38;79;120m/.test(during), JSON.stringify(during.slice(-260)))
  mouse(t, "up", to.col + 7, to.row)
  check("letting go says how much was copied", await waitFor(t, /copied 39 chars to clipboard/, 5000), screenOf(t).split("\n").filter((l) => /copied|clipboard/.test(l)).join(" | "))
  if (process.platform === "win32") check("and it is on the clipboard", clipboard() === "quick brown fox jumps over the lazy dog", JSON.stringify(clipboard()))
  check("the highlight stays after copying", /48;2;38;79;120m/.test(rawOf(t)))
  t.write("x"); await delay(300)
  check("typing lets the selection go, and types", !/48;2;38;79;120m/.test(rawOf(t)) && /\| x/.test(screenOf(t)))
  t.write("\x7f"); await delay(200)

  // Two rows: from the middle of one paragraph to the middle of the next.
  const second = find(t, "Second paragraph")
  mouse(t, "down", to.col, to.row); await delay(60); mouse(t, "drag", second.col + 5, second.row); await delay(200); mouse(t, "up", second.col + 5, second.row)
  await waitFor(t, /copied \d+ chars to clipboard/, 5000); await delay(400)
  if (process.platform === "win32") check("a drag across rows copies them as lines, without the margin", clipboard() === "lazy dog.\n\nSecond", JSON.stringify(clipboard()))
  t.write("\x1b"); await delay(200)

  // A plain click still does what it did: the toolbar opens Settings.
  const settingsAt = find(t, "[Settings]")
  mouse(t, "down", settingsAt.col + 2, settingsAt.row); await delay(60); mouse(t, "up", settingsAt.col + 2, settingsAt.row)
  check("a click without a drag is still a click", await waitFor(t, /Settings[\s\S]*Theme/, 4000))
  t.write("\x1b"); await delay(300)

  // --- a pasted picture can be removed ---
  if (process.platform === "win32") {
    execFileSync("powershell.exe", ["-NoProfile", "-STA", "-Command", "Add-Type -AssemblyName System.Windows.Forms, System.Drawing; $b = New-Object System.Drawing.Bitmap 8, 8; [System.Windows.Forms.Clipboard]::SetImage($b); $b.Dispose()"])
    t.write("\x1b[200~\x1b[201~")
    check("pasting a picture attaches it and says how to take it off", await waitFor(t, /images: \S+\.png\s+·\s+backspace at the start removes it/, 8000), screenOf(t).split("\n").filter((l) => /images|attached/.test(l)).join(" | "))
    for (const char of "hi") { t.write(char); await delay(50) }
    t.write("\x7f\x7f"); await delay(300)
    check("backspace over typed text deletes the text first, not the picture", /images: \S+\.png/.test(screenOf(t)))
    t.write("\x7f"); await delay(400)
    check("backspace in the empty prompt removes the picture", !/images: /.test(screenOf(t)) && /removed \S+\.png/.test(screenOf(t)), screenOf(t).split("\n").filter((l) => /images|removed/.test(l)).join(" | "))
  }

  // --- the model used last is the one it opens on ---
  check("it starts on the model it was launched with", /Local server fixture/.test(screenOf(t)))
} catch (error) { check("select pass", false, error.message) } finally { t.kill() }

// The settings file now names that model as most recent; a start with no --model must come back on it.
const settingsFile = fs.readdirSync(profile, { recursive: true }).map(String).find((name) => /settings\.json$/.test(name))
const stored = settingsFile ? JSON.parse(fs.readFileSync(path.join(profile, settingsFile), "utf8")) : {}
check("sending a message recorded its model as the most recent", /^local\//.test(stored.recents?.[0] ?? ""), JSON.stringify(stored.recents))
t = await tui({ model, cwd: project, profile, cols: 110, rows: 30, args: [] })
try {
  check("opened again with no model asked for, it is on the one used last", await waitFor(t, /ask · Local server fixture/, 8000), screenOf(t).split("\n").slice(-3).join(" | "))
} catch (error) { check("reopen pass", false, error.message) } finally { t.kill() }
setClipboard(before)
model.close()
// Ended outright once the result is written: after the second terminal, a plain process.exit never returns
// here (the pseudo-console library's exit handler waits on a console that is already gone).
process.stdout.write((failed() ? `\n${failed()} failed` : "\nall passed") + "\n", () => process.kill(process.pid, "SIGKILL"))
