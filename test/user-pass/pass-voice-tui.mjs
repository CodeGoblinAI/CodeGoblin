// User pass, terminal: voice input. Holding the space bar records and lets go to transcribe; /voice records
// until Enter; a terminal without the model gets the setup page, and nothing downloads unasked.
//
// The microphone is replaced by a spoken test recording (CG_VOICE_FAKE_WAV), made here with Windows' own
// voice; the speech model is the real one, read from a copy already on this machine. Skips when there is none.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { check, failed, fakeModel, tempDir, tui, delay, plain } from "./harness.mjs"

const modelDir = [process.env.CG_VOICE_MODEL_DIR, path.join(os.homedir(), ".local", "share", "codegoblin", "voice", "sensevoice"), path.join(os.homedir(), ".dsh", "speech-to-text", "sensevoice", "models", "sensevoice-onnx")]
  .find((dir) => dir && fs.existsSync(path.join(dir, "model.int8.onnx")) && fs.existsSync(path.join(dir, "tokens.txt")))
if (!modelDir || process.platform !== "win32") { console.log("no speech model on this machine (or not Windows) - skipped"); process.exit(0) }

const wav = path.join(tempDir("cg-voice-wav-"), "say.wav")
execFileSync("powershell.exe", ["-NoProfile", "-Command", `Add-Type -AssemblyName System.Speech; $f = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono); $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.SetOutputToWaveFile('${wav}', $f); $s.Speak('Please list the files in this folder and tell me which one is the largest.'); $s.Dispose()`])

const model = await fakeModel(() => ({ text: "should not be called" }))
const screenOf = (t) => plain(t.out.split("\x1b[2J").at(-1)).replace(/\r/g, "")
const boxOf = (t) => screenOf(t).split("\n").filter((line) => /^\s*\| /.test(line)).at(-1) ?? ""
const waitFor = async (t, pattern, ms = 15000) => { for (let waited = 0; waited < ms; waited += 200) { if (pattern.test(screenOf(t))) return true; await delay(200) } return false }
/** A held space bar: one space, the keyboard's pause, then repeats about thirty times a second. */
const holdSpace = async (t, ms) => { t.write(" "); await delay(450); for (let held = 450; held < ms; held += 35) { t.write(" "); await delay(35) } }

const t = await tui({ model, cwd: tempDir("cg-voice-project-"), cols: 120, rows: 36, extraEnv: { CG_VOICE_MODEL_DIR: modelDir, CG_VOICE_FAKE_WAV: wav } })
try {
  await waitFor(t, /ask · /)
  // Ordinary typing, spaces and all, is typing.
  for (const char of "two  words   here") { t.write(char); await delay(60) }
  await delay(300)
  check("typing with spaces - even several - is left as typed", /two {2}words {3}here/.test(boxOf(t)) && !/listening/.test(screenOf(t)), boxOf(t))
  t.write("\x15"); await delay(300)

  const holding = holdSpace(t, 1600)
  check("holding space shows that it is listening", await waitFor(t, /● listening .*let go of space to finish/, 4000), screenOf(t).split("\n").filter((l) => /listening|microphone/.test(l)).join(" | "))
  await holding
  check("letting go turns the speech into text in the prompt box", await waitFor(t, /list the files in this folder/i, 20000), boxOf(t))
  check("the held spaces did not stay in the box", !/^\s*\|\s{3,}/.test(boxOf(t)) && /\| Please/i.test(boxOf(t)), JSON.stringify(boxOf(t)))
  check("it says to read it over, and nothing was sent", /from your voice - read it over/.test(screenOf(t)) && model.seen.length === 0)

  // Spoken text joins what was already typed, after a space.
  t.write("\x15"); await delay(200)
  for (const char of "note:") { t.write(char); await delay(40) }
  t.write("/voice"); await delay(100); t.write("\x15"); await delay(200)
  for (const char of "note:") { t.write(char); await delay(40) }
  await holdSpace(t, 1300)
  await waitFor(t, /note: Please list the files/i, 20000)
  check("speech is added after what was typed", /note: Please list the files/i.test(boxOf(t)), boxOf(t))

  // /voice: start, Enter finishes; escape discards.
  t.write("\x15"); await delay(200); t.write("/voice\r")
  check("/voice starts listening and says how to finish", await waitFor(t, /● listening .*enter or space finishes/, 5000))
  await delay(600); t.write("\x1b")
  check("escape discards the recording", await waitFor(t, /recording discarded/, 4000) && !/Please list/i.test(boxOf(t)), boxOf(t))
  t.write("/voice\r"); await waitFor(t, /● listening/, 5000); await delay(600); t.write("\r")
  check("enter finishes a /voice recording and the text arrives", await waitFor(t, /\| Please list the files/i, 20000), boxOf(t))
  check("still nothing sent to the model", model.seen.length === 0)

  t.write("\x15"); await delay(200); t.write("/voice setup\r"); await delay(900)
  check("/voice setup shows it is ready, with the hold switch and language", /Voice input is set up/.test(screenOf(t)) && /Hold space to talk\s+on/.test(screenOf(t)) && /Language/.test(screenOf(t)))
  t.write("\x1b")
} catch (error) { check("voice pass", false, error.message) } finally { t.kill() }

// Without the model: the setup page, the numbers, and no download until asked.
const bare = await tui({ model, cwd: tempDir("cg-voice-project-"), cols: 120, rows: 36, extraEnv: { CG_VOICE_FAKE_WAV: wav } })
try {
  await waitFor(bare, /ask · /)
  await holdSpace(bare, 1200); await delay(400)
  check("without the model, holding space just types spaces", !/listening/.test(screenOf(bare)))
  bare.write("\x15"); await delay(200); bare.write("/voice\r"); await delay(1000)
  const page = screenOf(bare)
  check("/voice opens the setup page with what it needs", /Voice input/.test(page) && /229 MB/.test(page) && /nothing you say is sent anywhere/.test(page) && /Download and set up/.test(page) && /Later/.test(page), page.split("\n").filter((l) => /│/.test(l)).slice(0, 14).join("\n"))
  const profileVoice = fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith("cg-pass-profile-")).map((name) => path.join(os.tmpdir(), name, "data", "voice")).filter((dir) => fs.existsSync(dir))
  check("nothing was downloaded by looking", profileVoice.every((dir) => !fs.existsSync(path.join(dir, "sensevoice", "model.int8.onnx"))))
  bare.write("\x1b")
} catch (error) { check("voice setup pass", false, error.message) } finally { bare.kill() }
model.close()
console.log(failed() ? `\n${failed()} failed` : "\nall passed")
process.exit(0)
