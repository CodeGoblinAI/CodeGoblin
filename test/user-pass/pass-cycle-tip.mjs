// User pass, terminal: the home screen shows a tip, and F2 / shift+F2 step through recently used models.
import { check, failed, fakeModel, tempDir, tui, delay, plain } from "./harness.mjs"
const model = await fakeModel(() => ({ text: "should not be called" }))
const t = await tui({ model, cwd: tempDir("cg-cycle-project-"), cols: 120, rows: 40, args: ["--model", "refuseless/deepseek-v4.1-flash-fast"] })
const screen = () => plain(t.out.split("\x1b[2J").at(-1)).replace(/\r/g, "")
const bar = () => screen().split("\n").filter((line) => /ask · /.test(line)).at(-1) ?? ""
const key = async (keys, wait = 600) => { t.write(keys); await delay(wait) }
const F2 = "\x1bOQ", SHIFT_F2 = "\x1b[1;2Q"
try {
  for (let tries = 0; tries < 20 && !/ask · /.test(screen()); tries++) await delay(250)
  const tip = screen().split("\n").find((line) => /tip: /.test(line)) ?? ""
  check("the home screen shows a tip under the start line", /tip: \S/.test(tip), tip.trim())
  await key(F2, 500)
  check("F2 with no recent models says so instead of doing nothing", /no other recent model yet/.test(screen()), bar())
  // Two models chosen from the pop-up; each asks for its effort once, and Enter takes the default.
  for (const name of ["MiniMax", "Kimi K3.1"]) { await key("/model", 400); await key("\r", 900); await key(name, 700); await key("\r", 900); await key("\r", 600) }
  check("the second model chosen is the current one", /Kimi K3\.1 Pro/.test(bar()), bar())
  await key(F2, 600)
  check("F2 goes to the other recent model", /MiniMax M3\.1 Flash/.test(bar()), bar())
  await key(F2, 600)
  check("F2 again comes back round", /Kimi K3\.1 Pro/.test(bar()), bar())
  await key(SHIFT_F2, 600)
  check("shift+F2 goes the other way", /MiniMax M3\.1 Flash/.test(bar()), bar())
  check("nothing was sent to any model", model.seen.length === 0)
} catch (error) { check("cycle and tip pass", false, error.message) } finally { t.kill() }
model.close()
console.log(failed() ? `\n${failed()} failed` : "\nall passed")
process.exit(0)
