// User pass, web app: voice input. Click the microphone, speak, click again: the words are in the prompt box.
// Chromium's microphone is a spoken test recording; the speech model is the real one, read from a copy
// already on this machine. Without a model, the setup dialog shows what it needs and downloads nothing unasked.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { check, failed, fakeModel, tempDir, web } from "./harness.mjs"

const modelDir = [process.env.CG_VOICE_MODEL_DIR, path.join(os.homedir(), ".local", "share", "codegoblin", "voice", "sensevoice"), path.join(os.homedir(), ".dsh", "speech-to-text", "sensevoice", "models", "sensevoice-onnx")]
  .find((dir) => dir && fs.existsSync(path.join(dir, "model.int8.onnx")) && fs.existsSync(path.join(dir, "tokens.txt")))
if (!modelDir || process.platform !== "win32") { console.log("no speech model on this machine (or not Windows) - skipped"); process.exit(0) }

const wav = path.join(tempDir("cg-voice-wav-"), "say.wav")
execFileSync("powershell.exe", ["-NoProfile", "-Command", `Add-Type -AssemblyName System.Speech; $f = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(48000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono); $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.SetOutputToWaveFile('${wav}', $f); $s.Speak('Please list the files in this folder.'); $s.Dispose()`])
const mic = { browserArgs: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--use-file-for-fake-audio-capture=" + wav], permissions: ["microphone"] }

const model = await fakeModel(() => ({ text: "noted" }))
const hint = (w) => w.page.locator("#hint").innerText()
const w = await web({ model, cwd: tempDir("cg-voiceweb-project-"), extraEnv: { CG_VOICE_MODEL_DIR: modelDir }, ...mic })
try {
  check("the microphone sits beside Send", await w.page.locator("#mic").isVisible())
  await w.page.locator("#mic").click(); await w.page.waitForTimeout(800)
  check("clicking it starts listening, with a timer and how to finish", (await w.page.locator("#mic").getAttribute("aria-pressed")) === "true" && /listening - click the microphone or press Enter/.test(await hint(w)), await hint(w))
  await w.page.waitForTimeout(3600)
  await w.page.locator("#mic").click()
  await w.page.waitForFunction(() => /files in this folder/i.test(document.querySelector("textarea")?.value ?? ""), null, { timeout: 30000 }).catch(() => {})
  check("clicking again puts the spoken words in the prompt box", /list the files in this folder/i.test(await w.box.inputValue()), JSON.stringify(await w.box.inputValue()) + " · " + (await hint(w)))
  check("it says to read it over, and nothing was sent", /from your voice - read it over/.test(await hint(w)) && model.seen.length === 0, await hint(w))

  // Escape discards.
  await w.box.fill(""); await w.page.locator("#mic").click(); await w.page.waitForTimeout(900)
  await w.box.focus(); await w.page.keyboard.press("Escape"); await w.page.waitForTimeout(500)
  check("escape discards the recording", /recording discarded/.test(await hint(w)) && (await w.box.inputValue()) === "" && (await w.page.locator("#mic").getAttribute("aria-pressed")) === "false", await hint(w))

  // Hold Space in an empty prompt; let go to finish.
  await w.box.fill(""); await w.box.focus()
  await w.page.keyboard.down("Space")
  for (let i = 0; i < 5; i++) { await w.page.waitForTimeout(40); await w.page.keyboard.down("Space") }
  await w.page.waitForTimeout(700)
  check("holding space in an empty prompt starts listening", /let go of Space to finish/.test(await hint(w)), await hint(w))
  await w.page.waitForTimeout(3200)
  await w.page.keyboard.up("Space")
  await w.page.waitForFunction(() => /files in this folder/i.test(document.querySelector("textarea")?.value ?? ""), null, { timeout: 30000 }).catch(() => {})
  check("letting go puts the words in the box, with no stray spaces before them", /^\S.*files in this folder/i.test(await w.box.inputValue()), JSON.stringify(await w.box.inputValue()))
  // A tap of the bar in the middle of a sentence is a space.
  await w.box.fill(""); await w.box.pressSequentially("two words", { delay: 30 })
  check("typing a sentence with a space still types it", (await w.box.inputValue()) === "two words")
  check("no console errors", w.errors.length === 0, w.errors.join(" | "))
} catch (error) { check("web voice pass", false, error.message) } finally { await w.close() }

const bare = await web({ model, cwd: tempDir("cg-voiceweb-project-"), ...mic })
try {
  await bare.page.locator("#mic").click(); await bare.page.waitForTimeout(900)
  const text = await bare.page.locator("#voice-setup").innerText().catch(() => "")
  check("without the model, the microphone opens setup with what it needs", /Voice input/.test(text) && /229 MB/.test(text) && /nothing you say is sent anywhere/.test(text) && /Download and set up/.test(text) && /Later/.test(text), text.replace(/\n+/g, " | ").slice(0, 400))
  await bare.page.getByRole("button", { name: "Later" }).click(); await bare.page.waitForTimeout(300)
  check("Later closes it and nothing was downloaded", !(await bare.page.locator("#voice-setup").isVisible()) && !(await (await fetch(bare.url + "/api/voice").catch(() => ({ json: async () => ({}) }))).json()).preparing)
} catch (error) { check("web voice setup pass", false, error.message) } finally { await bare.close() }
model.close()
console.log(failed() ? `\n${failed()} failed` : "\nall passed")
process.exit(0)
