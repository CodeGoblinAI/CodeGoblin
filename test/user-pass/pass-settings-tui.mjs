// User pass, terminal: Settings reaches every generator's settings (Images, Audio, 3D models) and Memory,
// whichever model is selected.   SHOW=1 prints the screens.
import fs from "node:fs"
import path from "node:path"
import { check, failed, fakeModel, tempDir, tui, delay, plain } from "./harness.mjs"
const model = await fakeModel(() => ({ text: "noted" }))
const t = await tui({ model, cwd: tempDir("cg-settui-project-"), cols: 120, rows: 40 })
const screen = () => plain(t.out.split("\x1b[2J").at(-1)).replace(/\r/g, "")
const show = (label) => { if (process.env.SHOW) console.log("\n===== " + label + " =====\n" + screen().split("\n").map((l) => l.trimEnd()).filter(Boolean).join("\n")) }
const key = async (keys, wait = 450) => { t.write(keys); await delay(wait) }
const down = "\x1b[B"
try {
  await key("/settings\r", 700); show("settings")
  check("Settings lists Images, Audio, 3D models and Memory", ["  Images  ", "  Audio  ", "  3D models  ", "  Memory  "].every((name) => screen().includes(name)))
  // Walk down to Audio: it is the row after Images.
  for (let i = 0; i < 30 && !/❯\s+Audio\b/.test(screen()); i++) await key(down, 120)
  await key("\r", 600); show("audio models")
  check("Audio opens a list of voice models", /ElevenLabs/.test(screen()) && /enter opens a model's settings/.test(screen()))
  await key("\r", 600); show("one model's settings")
  check("a model opens its own settings", /Audio format/.test(screen()) && /Settings\s+·\s+ElevenLabs/.test(screen()))
  for (let i = 0; i < 10 && !/❯\s+Audio format/.test(screen()); i++) await key(down, 120)
  await key("\r", 600); show("values")
  await key(down, 200); await key("\r", 700); show("after choosing")
  const stored = JSON.parse(fs.readFileSync(path.join(t.profile, "state", "media.json"), "utf8"))
  check("a chosen value is saved for that model, not the selected one", Object.keys(stored).some((k) => /^elevenlabs\/.*audio\.format$/.test(k)), JSON.stringify(stored))
  check("and the list comes back showing it", /Audio format/.test(screen()) && /Settings\s+·\s+ElevenLabs/.test(screen()))
  await key("\x1b", 400)

  await key("/memory add the mascot is called Grobnar\r", 800)
  await key("/settings\r", 700)
  for (let i = 0; i < 30 && !/❯\s+Memory\b/.test(screen()); i++) await key(down, 120)
  await key("\r", 800); show("memory")
  check("Memory lists what is remembered", /Grobnar/.test(screen()) && /Remember something/.test(screen()))
  await key(down, 200); await key("\r", 500); show("armed")
  check("one Enter only asks", /press again/.test(screen()))
  await key("\r", 900); show("forgotten")
  check("a second forgets it", /nothing remembered yet/.test(screen()))
  await key("\r", 500); show("add")
  check("Remember something puts /memory add in the prompt", /\/memory add/.test(screen()) && !/Remember something/.test(screen()))
} catch (error) { check("settings pass", false, error.message) } finally { t.kill() }
model.close()
console.log(failed() ? `\n${failed()} failed` : "\nall passed")
process.exit(0)
