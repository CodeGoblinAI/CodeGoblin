// User pass, terminal: Refuseless is in /connect, the model pop-up and the effort picker, with no prompt sent.
// Also the pop-ups themselves: /model and /connect open one, and choosing a model asks for its effort once.
import { check, failed, fakeModel, tempDir, tui, delay, plain } from "./harness.mjs"
const model = await fakeModel(() => ({ text: "should not be called" }))
const t = await tui({ model, cwd: tempDir("cg-refuse-project-"), cols: 130, rows: 40, args: ["--model", "refuseless/deepseek-v4.1-flash-fast"] })
const screen = () => plain(t.out.split("\x1b[2J").at(-1)).replace(/\r/g, "")
const key = async (keys, wait = 600) => { t.write(keys); await delay(wait) }
// The status bar as last drawn: the line that starts with the approval mode.
const bar = () => screen().split("\n").filter((line) => /ask · /.test(line)).at(-1) ?? ""
const rowsWith =(text, pattern) => text.split("\n").filter((line) => pattern.test(line)).join(" | ")
try {
  await delay(500)
  check("starts on a Refuseless model", /Refuseless DeepSeek V4\.1 Flash 1017/.test(bar()), bar())
  await key("/connect refu")
  check("/connect lists Refuseless", /refuseless/i.test(screen()))
  await key("\x15", 200)
  await key("/model abliterated", 800)
  // Long ids are cut in the middle, so each row still shows which route it is.
  const rows = screen().split("\n").filter((line) => /\/model refuseless\//.test(line))
  check("the list under the prompt finds the five abliterated models", rows.length === 5, rows.length + " rows")
  check("a long id keeps its last word", rows.some((line) => /free\b/.test(line)) && rows.some((line) => /fast\b/.test(line)), rows.join(" | "))
  // Ctrl+U empties the box; Escape only closes the list and leaves the text.
  await key("\x15", 300)
  await key("/effort\r", 800)
  const effort = screen()
  check("the effort picker offers off, low, high and max, not medium", /\boff\b/.test(effort) && /\blow\b/.test(effort) && /\bmax\b/.test(effort) && !/\bmedium\b/.test(effort), rowsWith(effort, /│/).slice(0, 400))
  await key("\x1b", 300)

  // /model and Enter is a pop-up: models under their provider, names whole, then the effort question.
  await key("/model", 400); await key("\r", 900)
  const picker = screen()
  check("/model opens the model pop-up", /Choose model/.test(picker) && /type to search/.test(picker), picker.split("\n").slice(0, 6).join(" | "))
  await key("free route", 700)
  const found = screen()
  check("searching shows the free route by its whole name, with its price", /DeepSeek V4\.1 Flash 1017 Abliterated \(free route\)/.test(found) && /\$0\.12\/\$0\.45/.test(found), rowsWith(found, /free route/))
  await key("\r", 900)
  const asked = screen()
  check("choosing a model with effort levels asks for one straight away", /Effort/.test(asked) && /this model's default/.test(asked) && !/\bmedium\b/.test(asked), rowsWith(asked, /│/).slice(0, 400))
  await key("\r", 600)
  check("the bar names the model chosen", /free route/.test(bar()), bar())
  // Away to another model and back: the answer given once is kept, so it is not asked again.
  await key("/model", 400); await key("\r", 900); await key("MiniMax", 600); await key("\r", 900); await key("\x1b", 400)
  await key("/model", 400); await key("\r", 900); await key("free route", 700); await key("\r", 900)
  check("a model whose effort was answered once is not asked again", !/this model's default/.test(screen()) && /free route/.test(bar()), bar())
  await key("/connect", 400); await key("\r", 900)
  check("/connect opens the provider pop-up", /Connect a provider/.test(screen()) && /Refuseless/.test(screen()))
  await key("\x1b", 300)
  check("nothing was sent to any model", model.seen.length === 0)
} catch (error) { check("refuseless ui pass", false, error.message) } finally { t.kill() }
model.close()
console.log(failed() ? `\n${failed()} failed` : "\nall passed")
process.exit(0)
