// User pass: a conversation that cannot be saved says so. Every save used to drop its failure, so with the
// disk full or the folder not writable the conversation silently stopped being saved. Here the sessions
// folder cannot be made (a file is in its place); then it can.
import fs from "node:fs"
import path from "node:path"
import { check, failed, fakeModel, tempDir, tui, delay, plain } from "./harness.mjs"

const model = await fakeModel(() => ({ text: "answered" }))
const profile = tempDir("cg-unsaved-profile-")
const blocker = path.join(profile, "state", "sessions")
fs.mkdirSync(path.dirname(blocker), { recursive: true })
fs.writeFileSync(blocker, "not a folder")
const t = await tui({ model, cwd: tempDir("cg-unsaved-project-"), profile, cols: 140, rows: 40 })
const frame = () => plain(t.out.split("\x1b[2J").at(-1)).replace(/\r/g, "")
try {
  await delay(1200)
  t.write("first\r"); await t.until((s) => /could not be saved/.test(s), 10000, "warning")
  t.write("second\r"); await delay(2500)
  const rows = frame().split("\n").filter((line) => /This conversation could not be saved/.test(line))
  check("a conversation that cannot be saved says so, once, however many messages follow", rows.length === 1, frame().split("\n").filter((l) => /saved/.test(l)).join("\n"))
  check("and says the conversation is still there and what to check", /It is still here/.test(frame()) && /can be written/.test(frame()))

  // The folder can be made again: the next save works, and says so.
  fs.rmSync(blocker)
  t.write("third\r"); await t.until((s) => /being saved again/.test(s), 10000, "recovered")
  const saved = fs.existsSync(blocker) ? fs.readdirSync(blocker).filter((name) => name.endsWith(".json")) : []
  check("once it can be saved, it is, with everything said so far, and the conversation says so", saved.length === 1 && /being saved again/.test(frame()), saved.join(", "))
  const written = saved.length ? JSON.parse(fs.readFileSync(path.join(blocker, saved[0]), "utf8")) : { messages: [] }
  check("nothing said while it could not be saved was lost", ["first", "second", "third"].every((word) => written.messages.some((m) => m.role === "user" && m.content === word)), written.messages.filter((m) => m.role === "user").map((m) => m.content).join(", "))
} catch (error) { check("pass", false, error.message + "\n" + frame().slice(-600)) } finally { t.kill() }
model.close()
console.log(failed() ? `\n${failed()} failed` : "\nall passed")
if (process.platform === "win32") process.kill(process.pid)
process.exit(failed() ? 1 : 0)
