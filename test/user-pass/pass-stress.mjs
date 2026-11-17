// User pass, terminal: rough handling. Resize while an answer streams, down to a sliver and back; paste a lot,
// paste awkward things; an answer of one enormous word, of wide and combining characters; keys hammered while
// it draws; a conversation hundreds of messages long. The app must stay up, stay usable and lose nothing typed.
import fs from "node:fs"
import path from "node:path"
import { check, failed, fakeModel, tempDir, tui, delay, plain } from "./harness.mjs"

const seen = []
const model = await fakeModel(async (sent) => {
  const said = String(sent.messages.filter((m) => m.role === "user").at(-1)?.content ?? "")
  seen.push(said)
  if (/slow stream/.test(said)) return { stream: Array.from({ length: 60 }, (_, n) => ({ text: "streamed line " + (n + 1) + " of sixty, with enough words in it to wrap when the window is narrow.\n" })), gap: 60 }
  if (/one word/.test(said)) return { text: "start " + "x".repeat(3000) + " end-of-the-long-word-answer" }
  if (/wide/.test(said)) return { text: "日本語のテキストが続きます。".repeat(8) + "\n\nemoji: 🎉🚀👩‍💻🇯🇵 done\n\ncombining: é ä ô zero\u200bwidth\n\n| 列 | 値 |\n| --- | --- |\n| 名前 | 太郎 🎌 |\n\nwide-answer-finished" }
  if (/big table/.test(said)) return { text: "| " + Array.from({ length: 14 }, (_, n) => "column " + n).join(" | ") + " |\n| " + Array.from({ length: 14 }, () => "---").join(" | ") + " |\n| " + Array.from({ length: 14 }, (_, n) => "a fairly long cell value " + n).join(" | ") + " |\n\ntable-finished" }
  return { text: "reply to: " + said.slice(0, 50).replace(/\s+/g, " ") }
})
const screenOf = (t) => plain(t.out.split("\x1b[2J").at(-1)).replace(/\r/g, "")
const boxOf = (t) => screenOf(t).split("\n").filter((line) => /^\s*\| /.test(line)).at(-1) ?? ""
const waitFor = async (t, pattern, ms = 15000) => { for (let waited = 0; waited < ms; waited += 150) { if (pattern.test(screenOf(t))) return true; await delay(150) } return false }
const type = async (t, text) => { for (const char of text) { t.write(char); await delay(20) } }
const broken = (t) => /TypeError|RangeError|ReferenceError|Unhandled|something went wrong|unexpected error|at <anonymous>|\bat .*:\d+:\d+\)/.test(plain(t.out))
const alive = async (t, label) => {
  t.write("\x15"); await delay(150)
  await type(t, "still here " + label); t.write("\r")
  return waitFor(t, new RegExp("reply to: still here " + label), 12000)
}

const profile = tempDir("cg-stress-profile-")
const project = tempDir("cg-stress-project-")
const t = await tui({ model, cwd: project, profile, cols: 120, rows: 36 })
try {
  // --- resize while streaming ---
  await type(t, "slow stream please"); t.write("\r"); await delay(600)
  for (const [cols, rows] of [[80, 24], [40, 12], [20, 6], [12, 4], [200, 60], [60, 10], [120, 36]]) { t.term.resize(cols, rows); await delay(350) }
  check("resized seven times while an answer streamed, down to 12x4 and back: no error", await waitFor(t, /streamed line 60 of sixty/, 20000) && !broken(t), plain(t.out).split("\n").filter((l) => /Error|unexpected/.test(l)).slice(0, 3).join(" | "))
  check("and it still answers", await alive(t, "after resize"))

  // --- a sliver of a window ---
  t.term.resize(16, 5); await delay(600)
  await type(t, "tiny"); t.write("\r"); await delay(2500)
  t.term.resize(120, 36); await delay(800)
  check("used at 16x5 and widened again: no error, and the prompt sent there was answered", !broken(t) && seen.includes("tiny") && await waitFor(t, /reply to: tiny/, 8000), screenOf(t).slice(-300))

  // --- pastes ---
  const big = Array.from({ length: 900 }, (_, n) => "pasted line " + (n + 1) + " with some ordinary words in it").join("\n")
  t.write("\x1b[200~" + big + "\x1b[201~"); await delay(1500)
  check("a 900-line paste is folded to one token, and the app stays quick", /\[Pasted ~900 lines\]/.test(boxOf(t)) && !broken(t), boxOf(t))
  const before = Date.now()
  t.write("\r")
  check("sending it gives the model every line", await waitFor(t, /reply to: pasted line 1 with/, 15000) && seen.some((said) => said.includes("pasted line 900 with")), `${Date.now() - before} ms`)
  t.write("\x1b[200~first line\r\nsecond line\r\n\tindented with a tab\r\n\x1b[201~"); await delay(600)
  t.write("\r"); await waitFor(t, /reply to: first line/, 8000)
  const crlf = seen.find((said) => said.startsWith("first line"))
  check("a paste with Windows line endings and a tab arrives as lines, without stray carriage returns", Boolean(crlf) && !crlf.includes("\r") && crlf.includes("second line") && /indented with a tab/.test(crlf), JSON.stringify(crlf))
  t.write("\x1b[200~looks like keys: \x1b[A \x1b[2J \x03 \x1b[201~"); await delay(600)
  check("a paste with control codes in it is text, not commands: the app is still drawn and running", /looks like keys/.test(boxOf(t)) && !broken(t), boxOf(t))
  t.write("\x15"); await delay(300)

  // --- awkward answers ---
  await type(t, "one word"); t.write("\r")
  check("an answer that is one 3,000-character word is wrapped and finishes", await waitFor(t, /end-of-the-long-word-answer/, 10000) && !broken(t))
  check("no line of it runs past the window", screenOf(t).split("\n").every((line) => line.length <= 122), String(Math.max(...screenOf(t).split("\n").map((line) => line.length))))
  await type(t, "wide"); t.write("\r")
  check("Japanese, emoji, combining marks and a table of them are drawn and finish", await waitFor(t, /wide-answer-finished/, 10000) && !broken(t), screenOf(t).split("\n").slice(-12).join("\n"))
  await type(t, "big table"); t.write("\r")
  check("a table far wider than the window finishes without an error", await waitFor(t, /table-finished/, 10000) && !broken(t))

  // --- keys hammered while it draws ---
  await type(t, "slow stream again"); t.write("\r"); await delay(400)
  for (let n = 0; n < 120; n++) { t.write(["a", "\x7f", "\x1b[A", "\x1b[B", "\x1b[5~", "\x1b[6~", "\x0f", "b", "\x7f", "\x1b[<64;40;10M", "\x1b[<65;40;10M"][n % 11]); await delay(12) }
  t.write("\x1b[1;5F"); await delay(300)
  check("a hundred and twenty keys, wheel turns and folds while it streamed: no error, and it finishes", await waitFor(t, /streamed line 60 of sixty/, 25000) && !broken(t), plain(t.out).split("\n").filter((l) => /Error|unexpected/.test(l)).slice(0, 3).join(" | "))
  check("and it still answers", await alive(t, "after keys"))
} catch (error) { check("pass", false, error.message + "\n" + screenOf(t).slice(-600)) } finally { t.kill() }

// --- a very long conversation, reopened ---
{
  const id = "stress-long-session"
  const messages = []
  for (let n = 1; n <= 1500; n++) messages.push({ role: "user", content: "question number " + n }, { role: "assistant", content: "answer number " + n + ": " + "some text. ".repeat(20) })
  fs.mkdirSync(path.join(profile, "state", "sessions"), { recursive: true })
  fs.writeFileSync(path.join(profile, "state", "sessions", id + ".json"), JSON.stringify({ id, title: "Three thousand messages", created: Date.now() - 1000, updated: Date.now(), provider: "local", model: "fixture", root: project, messages }))
  const again = await tui({ model, cwd: project, profile, cols: 120, rows: 36 })
  try {
    again.write("/resume\r"); await delay(1500)
    const listed = /Three thousand messages/.test(screenOf(again))
    const opened = Date.now()
    again.write("\r")
    const shown = await waitFor(again, /answer number 1500/, 15000)
    const took = Date.now() - opened
    check("a conversation of 3,000 messages is listed and opens within a few seconds", listed && shown && took < 6000, `${took} ms`)
    const typed = Date.now()
    await type(again, "typing in a long conversation")
    check("typing in it is not sluggish", await waitFor(again, /\| typing in a long conversation/, 4000) && Date.now() - typed < 4000, `${Date.now() - typed} ms for 29 characters`)
    again.write("\r")
    check("and it carries on from there", await waitFor(again, /reply to: typing in a long conversation/, 15000) && !broken(again))
  } catch (error) { check("long conversation", false, error.message + "\n" + screenOf(again).slice(-400)) } finally { again.kill() }
}
model.close()
console.log(failed() ? `\n${failed()} failed` : "\nall passed")
if (process.platform === "win32") process.kill(process.pid)
process.exit(failed() ? 1 : 0)
