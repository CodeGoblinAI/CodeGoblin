// User pass: tui.json keybinds move the leader and a shortcut.
import fs from "node:fs"
import path from "node:path"
import { check, failed, fakeModel, tempDir, tui, delay } from "./harness.mjs"
const model = await fakeModel(() => ({ text: "ok" }))
const profile = tempDir("cg-keys-profile-")
fs.mkdirSync(path.join(profile, "config"), { recursive: true })
fs.writeFileSync(path.join(profile, "config", "tui.json"), JSON.stringify({ keybinds: { leader: "ctrl+b", model_list: "<leader>k", app_exit: "none" } }))
const t = await tui({ model, cwd: tempDir("cg-keys-project-"), profile })
try {
  t.write("\x02"); await delay(300)
  const shown = t.screen().split("\n").filter((l) => /ctrl\+b/.test(l)).slice(-1).join("")
  check("ctrl+b is the leader now, and the list shows k for model and no quit", /ctrl\+b\s+k model/.test(shown) && !/q quit/.test(shown), shown)
  t.write("k"); await delay(700)
  check("ctrl+b k opens the model picker", /Choose model/.test(t.screen()))
  t.write("\x1b"); await delay(300)
  t.clear(); t.write("\x18"); await delay(300)
  check("ctrl+x no longer arms anything", !/ctrl\+x\s+m model/.test(t.screen()))
} catch (error) { check("TUI pass", false, error.message) } finally { t.kill() }
model.close()
console.log(failed() ? `\n${failed()} failed` : "\nall passed")
process.exit(0)
