// User pass: what an approval asks to run is shown whole, in the terminal and the web.
//
// The terminal cut the command at the box's edge and the web at 160 characters, and the part of a chained
// command that matters is usually its end. A command carrying a terminal code had its middle removed on the
// way to the screen, and a right-to-left override could draw it in another order.
import { check, failed, fakeModel, tempDir, tui, web, delay, plain } from "./harness.mjs"

const ESC = "\x1b", BEL = "\x07"
const LONG = Array.from({ length: 12 }, (_, n) => "git commit --allow-empty -m step-" + (n + 1)).join(" && ") + " && git push origin THE-END-OF-IT"
const HIDDEN = "npm run build " + ESC + "]0;; npm publish HIDDEN-PART " + BEL
const REVERSED = "npm publish #\u202e safe"
const commands = [LONG, HIDDEN, REVERSED]
const model = await fakeModel((sent) => {
  const tools = sent.messages.filter((m) => m.role === "tool").length
  return tools < commands.length ? { tool: "shell", args: { command: commands[tools] } } : { text: "all three were asked about" }
})
const project = tempDir("cg-approval-project-")

// --- TUI ---
const t = await tui({ model, cwd: project, cols: 100, rows: 34 })
try {
  t.write("go\r")
  await t.until((s) => /allow shell/.test(s), 10000, "first prompt")
  await delay(400)
  let screen = t.screen()
  check("TUI: a long chained command is shown to its end", /THE-END-OF-IT/.test(screen) && /step-1\b/.test(screen) && /step-7\b/.test(screen), screen.split("\n").filter((l) => /step|END|allow/.test(l)).join("\n"))
  const frame = plain(t.out.split("\x1b[2J").at(-1)).replace(/\r/g, "").split("\n")
  check("TUI: and nothing of the screen ran past the window", frame.every((line) => line.length <= 100), String(Math.max(...frame.map((line) => line.length))))
  const reject = () => t.write("\x1b[B\x1b[B\r") // down twice is Reject
  reject()
  await t.until((s) => /HIDDEN-PART/.test(s), 10000, "second prompt").catch(() => {})
  screen = t.screen()
  check("TUI: a command with a terminal code in it is shown whole, the code made visible", /HIDDEN-PART/.test(screen) && /\u241b\]0;/.test(screen), screen.split("\n").filter((l) => /allow|npm/.test(l)).join("\n"))
  check("TUI: and no title code reached the terminal", !t.out.includes(ESC + "]0;;"))
  reject()
  await t.until((s) => /U\+202E/.test(s), 10000, "third prompt").catch(() => {})
  screen = t.screen()
  check("TUI: a right-to-left override in a command is named, not obeyed", /<U\+202E>/.test(screen) && !t.out.includes("\u202e"), screen.split("\n").filter((l) => /allow|U\+/.test(l)).join("\n"))
  reject()
  await t.until((s) => /all three were asked about/.test(s), 10000, "answer").catch(() => {})
} catch (error) { check("TUI pass", false, error.message + "\n" + t.screen().slice(-800)) } finally { t.kill() }

// --- Web ---
model.seen.length = 0
const w = await web({ model, cwd: project, viewport: { width: 900, height: 800 } })
try {
  await w.send("/model local/fixture")
  await w.send("go", 2000)
  const prompt = w.page.locator(".permission[data-permission]").last()
  const detail = prompt.locator(".pdetail")
  const shown = await detail.innerText()
  check("web: a long chained command is shown to its end", shown.includes("THE-END-OF-IT") && shown.includes("step-1 "), shown.slice(-120))
  const box = await detail.boundingBox()
  const scrollWidth = await detail.evaluate((el) => el.scrollWidth - el.clientWidth)
  check("web: it wraps inside the box instead of running off it", box !== null && box.width <= 900 && scrollWidth <= 1, `width ${box?.width}, overflow ${scrollWidth}`)
  await prompt.getByRole("button", { name: "Reject" }).click()
  await w.page.waitForTimeout(1500)
  const second = await w.page.locator(".permission[data-permission]").last().locator(".pdetail").innerText()
  check("web: a command with a terminal code in it is shown whole", second.includes("HIDDEN-PART") && second.includes("\u241b"), JSON.stringify(second))
  await w.page.locator(".permission[data-permission]").last().getByRole("button", { name: "Reject" }).click()
  await w.page.waitForTimeout(1500)
  const third = await w.page.locator(".permission[data-permission]").last().locator(".pdetail").innerText()
  check("web: a right-to-left override is named, not obeyed", third.includes("<U+202E>") && !third.includes("\u202e"), JSON.stringify(third))
  await w.page.locator(".permission[data-permission]").last().getByRole("button", { name: "Reject" }).click()
  await w.page.waitForTimeout(1000)
  check("web: no console errors", w.errors.length === 0, w.errors.join(" | "))
} catch (error) { check("web pass", false, error.message) } finally { await w.close() }
model.close()
console.log(failed() ? `\n${failed()} failed` : "\nall passed")
if (process.platform === "win32") process.kill(process.pid)
process.exit(failed() ? 1 : 0)
