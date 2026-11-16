// User pass, terminal: the things people do while an answer is still running. Queue several messages, take one
// back and drop it, take one back and change it, send one now, change the model and the effort mid-answer,
// stop with messages waiting. What the model was actually sent, and in what order, is the check.
import { check, failed, fakeModel, tempDir, tui, delay, plain } from "./harness.mjs"

const UP = "\x1b[A", CTRL_U = "\x15", CTRL_S = "\x13", ESC = "\x1b"
const asked = []
const model = await fakeModel(async (sent) => {
  const said = String(sent.messages.filter((m) => m.role === "user").at(-1)?.content ?? "")
  asked.push({ said, model: sent.model, effort: sent.reasoning_effort ?? sent.reasoning?.effort ?? sent.thinking?.type })
  if (/slow/.test(said)) await delay(6000)
  return { text: "answer to: " + said.slice(0, 40) }
})
const screenOf = (t) => plain(t.out.split("\x1b[2J").at(-1)).replace(/\r/g, "")
const boxOf = (t) => screenOf(t).split("\n").filter((line) => /^\s*\| /.test(line)).at(-1) ?? ""
const waitFor = async (t, pattern, ms = 15000) => { for (let waited = 0; waited < ms; waited += 150) { if (pattern.test(screenOf(t))) return true; await delay(150) } return false }
const type = async (t, text) => { for (const char of text) { t.write(char); await delay(25) } }
const saidList = () => asked.map((each) => each.said.split("\n")[0])

const t = await tui({ model, cwd: tempDir("cg-queue-odd-"), cols: 130, rows: 40 })
try {
  // --- several queued, one dropped, one changed, one sent now ---
  await type(t, "slow first"); t.write("\r")
  await waitFor(t, /esc twice stops|enter queue/, 5000)
  await type(t, "second"); t.write("\r"); await delay(300)
  check("a queued message says how to send it now and how to take it back", /queued · ctrl\+s sends now · up takes it back/.test(screenOf(t)), screenOf(t).split("\n").filter((l) => /queued|ctrl\+s/.test(l)).join("\n"))
  await type(t, "third"); t.write("\r"); await delay(300)
  check("a second one waits behind it", /\+ 1 more after it/.test(screenOf(t)))

  t.write(UP); await delay(300)
  check("up, with nothing typed, takes the newest queued message back into the box", /\| third/.test(boxOf(t)) && !/\+ 1 more after it/.test(screenOf(t)), boxOf(t))
  t.write(CTRL_U); await delay(300)
  check("clearing it drops it: only the other one still waits", /ask the goblin|type to queue/.test(boxOf(t)) || !/third/.test(boxOf(t)), boxOf(t))

  t.write(UP); await delay(300)
  check("up again takes the remaining one back, and nothing is left waiting", /\| second/.test(boxOf(t)) && !/queued · ctrl\+s/.test(screenOf(t)), boxOf(t))
  await type(t, " edited"); t.write("\r"); await delay(300)
  check("changed and queued again", /second edited/.test(screenOf(t)) && /queued · ctrl\+s/.test(screenOf(t)))

  await type(t, "urgent"); t.write(CTRL_S)
  check("ctrl+s stops the answer and sends what is typed now", await waitFor(t, /answer to: urgent/, 12000), screenOf(t).split("\n").filter((l) => /urgent|interrupt/.test(l)).slice(-3).join("\n"))
  check("the queued one follows it by itself", await waitFor(t, /answer to: second edited/, 12000))
  await delay(500)
  check("the model was sent them in that order, and never the dropped one", JSON.stringify(saidList()) === JSON.stringify(["slow first", "urgent", "second edited"]), JSON.stringify(saidList()))

  // --- ctrl+s with nothing typed sends the queued one now ---
  await type(t, "slow again"); t.write("\r"); await waitFor(t, /esc twice stops|enter queue/, 5000)
  await type(t, "waiting one"); t.write("\r"); await delay(300)
  const before = Date.now()
  t.write(CTRL_S)
  check("ctrl+s with nothing typed sends the waiting message at once", await waitFor(t, /answer to: waiting one/, 5000) && Date.now() - before < 5000, `${Date.now() - before} ms`)

  // --- model and effort changed while an answer runs ---
  await type(t, "slow third"); t.write("\r"); await waitFor(t, /esc twice stops|enter queue/, 5000)
  await type(t, "/effort high"); t.write("\r"); await delay(500)
  const effortScreen = screenOf(t)
  await type(t, "/model local"); t.write("\r"); await delay(500)
  check("/effort and /model typed mid-answer do not break it or stop it", !/TypeError|Unhandled|unexpected/i.test(screenOf(t)), screenOf(t).split("\n").filter((l) => /effort|model|queued/i.test(l)).slice(-4).join("\n") + "\n" + effortScreen.split("\n").filter((l) => /effort/i.test(l)).slice(-2).join("\n"))
  check("the running answer still arrives", await waitFor(t, /answer to: slow third/, 15000))
  await delay(1500)
  await type(t, "after the switch"); t.write("\r")
  check("and the next prompt is answered", await waitFor(t, /answer to: after the switch/, 15000), screenOf(t).slice(-400))

  // --- stopping with messages waiting ---
  const count = asked.length
  await type(t, "slow fourth"); t.write("\r"); await waitFor(t, /esc twice stops|enter queue/, 5000)
  await type(t, "left waiting"); t.write("\r"); await delay(300)
  t.write(ESC); await delay(150); t.write(ESC); await delay(2500)
  const after = screenOf(t)
  const sentAnyway = asked.slice(count).some((each) => /left waiting/.test(each.said))
  check("esc twice stops the answer; what was waiting is not thrown away", sentAnyway || /left waiting/.test(after), sentAnyway ? "it was sent after the stop" : "it is still on screen: " + after.split("\n").filter((l) => /left waiting|queued|stopped/.test(l)).slice(-3).join(" | "))
  console.log("     (after a stop the waiting message was " + (sentAnyway ? "sent" : "kept, not sent") + ")")
} catch (error) { check("pass", false, error.message + "\n" + screenOf(t).slice(-600)) } finally { t.kill() }
model.close()
console.log(failed() ? `\n${failed()} failed` : "\nall passed")
process.exit(failed() ? 1 : 0)
