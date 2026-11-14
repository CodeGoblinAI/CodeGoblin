// User pass, terminal: Refuseless is in /connect, the model picker and the effort picker, with no prompt sent.
import { check, failed, fakeModel, tempDir, tui, delay, plain } from "./harness.mjs"
const model = await fakeModel(() => ({ text: "should not be called" }))
const t = await tui({ model, cwd: tempDir("cg-refuse-project-"), cols: 130, rows: 40, args: ["--model", "refuseless/deepseek-v4.1-flash-fast"] })
const screen = () => plain(t.out.split("\x1b[2J").at(-1)).replace(/\r/g, "")
const key = async (keys, wait = 600) => { t.write(keys); await delay(wait) }
try {
  check("starts on a Refuseless model", /Refuseless DeepSeek V4\.1 Flash 1017/.test(screen()), screen().split("\n").slice(-3).join(" | "))
  await key("/connect refu"); 
  check("/connect lists Refuseless", /refuseless/i.test(screen()))
  await key("\x15", 200)
  await key("/model abliterated", 800)
  const rows = screen().split("\n").filter((line) => /refuseless\/[a-z0-9.-]*abliterated/.test(line))
  check("the model list finds the five abliterated models", rows.length === 5, rows.length + " rows")
  // Ctrl+U empties the box; Escape only closes the list and leaves the text.
  await key("\x15", 300)
  await key("/effort\r", 800)
  const effort = screen()
  check("the effort picker offers off, low, high and max, not medium", /\boff\b/.test(effort) && /\blow\b/.test(effort) && /\bmax\b/.test(effort) && !/\bmedium\b/.test(effort), effort.split("\n").filter((l) => /│/.test(l)).slice(0, 8).join(" | "))
  await key("\x1b", 300)
  check("nothing was sent to any model", model.seen.length === 0)
} catch (error) { check("refuseless ui pass", false, error.message) } finally { t.kill() }
model.close()
console.log(failed() ? `\n${failed()} failed` : "\nall passed")
process.exit(0)
