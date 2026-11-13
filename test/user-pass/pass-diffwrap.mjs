// User pass: Diff wrapping in the TUI's /diff viewer.
import fs from "node:fs"
import path from "node:path"
import { check, failed, fakeModel, tempDir, tui, delay } from "./harness.mjs"
const long = "const message = '" + "word ".repeat(40) + "END_OF_LONG_LINE'"
const model = await fakeModel((sent) => {
  const lastUser = sent.messages.map((m) => m.role).lastIndexOf("user")
  return sent.messages.slice(lastUser + 1).some((m) => m.role === "tool") ? { text: "wrote" } : { tool: "write_file", args: { path: "long.ts", content: long + "\n" } }
})
const profile = tempDir("cg-diffwrap-profile-")
fs.mkdirSync(path.join(profile, "state"), { recursive: true })
fs.writeFileSync(path.join(profile, "state", "settings.json"), JSON.stringify({ diffWrap: true }))
const t = await tui({ model, cwd: tempDir("cg-diffwrap-project-"), profile })
try {
  t.write("\x1b[Z"); await delay(300)
  t.write("write it\r"); await t.until((s) => /wrote/.test(s), 10000, "turn")
  t.clear(); t.write("/diff\r"); await delay(900)
  t.write("\r"); await delay(900)
  check("TUI: with Diff wrapping on, the long line's end is shown on a continuation row", /END_OF_LONG_LINE/.test(t.screen()), t.screen().split("\n").filter((l) => /word|END_OF/.test(l)).slice(-3).join("\n"))
  t.write("\x1b"); await delay(300)
  t.clear(); t.write("/settings\r"); await delay(700)
  check("TUI: Settings shows it", /Diff wrapping\s*on/.test(t.screen()))
} catch (error) { check("TUI pass", false, error.message) } finally { t.kill() }
model.close()
console.log(failed() ? `\n${failed()} failed` : "\nall passed")
process.exit(0)
