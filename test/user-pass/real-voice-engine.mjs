// Voice input in the built program, from nothing: the program has no speech engine inside it, so /voice
// fetches one (about 10 MB from the npm registry, for real - this is the one thing here that uses the network),
// and then a spoken recording becomes text in the prompt box.
//
// The speech model is a copy already on this machine (it is 229 MB; skipped when there is none), and the
// microphone is a recording made with Windows' own voice. Windows only, like the other voice passes.
//   bun script/build.ts && node test/user-pass/real-voice-engine.mjs
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")
process.env.CG_BIN ??= path.join(root, "dist", `codegoblin-windows-${process.arch}`, "bin", "codegoblin.exe")
const modelDir = [process.env.CG_VOICE_MODEL_DIR, path.join(os.homedir(), ".local", "share", "codegoblin", "voice", "sensevoice"), path.join(os.homedir(), ".dsh", "speech-to-text", "sensevoice", "models", "sensevoice-onnx")]
  .find((dir) => dir && fs.existsSync(path.join(dir, "model.int8.onnx")) && fs.existsSync(path.join(dir, "tokens.txt")))
if (!modelDir || process.platform !== "win32" || !fs.existsSync(process.env.CG_BIN)) { console.log("needs Windows, a built program and a speech model on this machine - skipped"); process.exit(0) }
const { check, failed, fakeModel, tempDir, tui, delay, plain } = await import("./harness.mjs")

const wav = path.join(tempDir("cg-voice-wav-"), "say.wav")
execFileSync("powershell.exe", ["-NoProfile", "-Command", `Add-Type -AssemblyName System.Speech; $f = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono); $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.SetOutputToWaveFile('${wav}', $f); $s.Speak('Please list the files in this folder and tell me which one is the largest.'); $s.Dispose()`])

const model = await fakeModel(() => ({ text: "should not be called" }))
const profile = tempDir("cg-voice-engine-profile-")
const engine = path.join(profile, "data", "voice", "engine-2.0.1")
const screenOf = (t) => plain(t.out.split("\x1b[2J").at(-1)).replace(/\r/g, "")
const boxOf = (t) => screenOf(t).split("\n").filter((line) => /^\s*\| /.test(line)).at(-1) ?? ""
const waitFor = async (t, pattern, ms = 15000) => { for (let waited = 0; waited < ms; waited += 200) { if (pattern.test(screenOf(t))) return true; await delay(200) } return false }
const holdSpace = async (t, ms) => { t.write(" "); await delay(450); for (let held = 450; held < ms; held += 35) { t.write(" "); await delay(35) } }

const extraEnv = { CG_VOICE_MODEL_DIR: modelDir, CG_VOICE_FAKE_WAV: wav, CG_VOICE_ENGINE_DIR: "", CODEGOBLIN_DISABLE_AUTOUPDATE: "1" }
let t = await tui({ model, cwd: tempDir("cg-voice-engine-project-"), profile, cols: 120, rows: 36, extraEnv })
try {
  await waitFor(t, /ask · /)
  check("the program starts with no speech engine on disk", !fs.existsSync(engine))
  t.write("/voice\r")
  check("/voice says an engine has to be fetched too, how big it is and where from", await waitFor(t, /and its engine, 10 MB, from the npm registry/, 5000), screenOf(t).split("\n").filter((l) => /Download|engine|Disk/.test(l)).join("\n"))
  check("nothing was fetched just by looking", !fs.existsSync(engine))
  const started = Date.now()
  t.write("\r")
  check("Download and set up fetches it and voice is ready", await waitFor(t, /voice is ready/, 120000), screenOf(t).split("\n").filter((l) => /voice/.test(l)).slice(-2).join("\n"))
  const files = fs.existsSync(engine) ? fs.readdirSync(path.join(engine, "node_modules")) : []
  check("the engine is in the profile: its loader and this computer's library", files.includes("sherpa-onnx-node") && files.some((name) => /^sherpa-onnx-win-/.test(name)), files.join(", ") + ` (${((Date.now() - started) / 1000).toFixed(0)}s)`)
  check("no half-finished folder is left beside it", fs.readdirSync(path.dirname(engine)).every((name) => !name.includes(".part-")), fs.readdirSync(path.dirname(engine)).join(", "))

  const holding = holdSpace(t, 1600)
  check("holding space listens", await waitFor(t, /● listening/, 4000))
  await holding
  check("the built program turns the speech into text with the engine it fetched", await waitFor(t, /list the files in this folder/i, 30000), boxOf(t))
  check("nothing was sent to a model", model.seen.length === 0)
} catch (error) { check("pass", false, error.message) } finally { t.kill() }

// A second start: nothing to fetch, voice simply works.
t = await tui({ model, cwd: tempDir("cg-voice-engine-project-"), profile, cols: 120, rows: 36, extraEnv })
try {
  await waitFor(t, /ask · /)
  const holding = holdSpace(t, 1600)
  check("next start: holding space listens straight away", await waitFor(t, /● listening/, 4000), screenOf(t).split("\n").filter((l) => /voice|listening/.test(l)).join(" | "))
  await holding
  check("next start: speech becomes text again", await waitFor(t, /list the files in this folder/i, 30000), boxOf(t))
} catch (error) { check("second pass", false, error.message) } finally { t.kill() }
model.close()
console.log(failed() ? `\n${failed()} failed` : "\nall passed")
process.exit(failed() ? 1 : 0)
