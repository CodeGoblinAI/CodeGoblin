import { describe, expect, test } from "bun:test"
import { VOICE_ASSETS, VOICE_BYTES, dataChunk, heardSomething, tidy, voiceProblem, wavFromPcm16, wavSeconds } from "../src/core/voice"
import { quietCut } from "../src/core/voice-worker"
import { sourceUrl } from "../src/core/local-downloads"
import { normalise } from "../src/core/settings"
import { runCommand } from "../src/core/commands"

const tone = (seconds: number, level: number) => Int16Array.from({ length: Math.round(seconds * 16000) }, (_, i) => Math.round(Math.sin(i / 8) * level * 32767))

describe("voice input", () => {
  test("the model is pinned to one commit, with its size and hash", () => {
    expect(VOICE_ASSETS.map((asset) => asset.file)).toEqual(["tokens.txt", "model.int8.onnx"])
    for (const asset of VOICE_ASSETS) {
      expect(sourceUrl(asset)).toMatch(/^https:\/\/huggingface\.co\/csukuangfj\/sherpa-onnx-sense-voice-[^/]+\/resolve\/[0-9a-f]{40}\//)
      expect(asset.sha256).toMatch(/^[0-9a-f]{64}$/)
    }
    expect(VOICE_BYTES).toBe(239_549_735)
    // A model without a revision still downloads from main, as the local chat models do.
    expect(sourceUrl({ id: "x", label: "x", repo: "a/b", file: "c.gguf", bytes: 1, sha256: "0", about: "" })).toBe("https://huggingface.co/a/b/resolve/main/c.gguf")
  })

  test("a WAV is measured from its data chunk, wherever that is, and other formats are refused", () => {
    const wav = wavFromPcm16(tone(1.5, 0.2))
    expect(wavSeconds(wav)).toBe(1.5)
    expect(dataChunk(wav)).toEqual({ offset: 44, length: 48000 })
    // A LIST chunk before the audio, as some recorders write.
    const extra = new Uint8Array(wav.length + 12)
    extra.set(wav.subarray(0, 36)); extra.set([0x4c, 0x49, 0x53, 0x54, 4, 0, 0, 0, 1, 2, 3, 4], 36); extra.set(wav.subarray(36), 48)
    expect(dataChunk(extra)).toEqual({ offset: 56, length: 48000 })
    expect(wavSeconds(extra)).toBe(1.5)
    const stereo = wavFromPcm16(tone(1, 0.2)); new DataView(stereo.buffer).setUint16(22, 2, true)
    expect(() => wavSeconds(stereo)).toThrow("16 kHz, mono, 16-bit")
    expect(() => wavSeconds(new Uint8Array(100))).toThrow("not a WAV")
  })

  test("silence and a faint hiss are not speech; a voice-level sound is", () => {
    expect(heardSomething(wavFromPcm16(new Int16Array(32000)))).toBe(false)
    expect(heardSomething(wavFromPcm16(tone(2, 0.003)))).toBe(false)
    expect(heardSomething(wavFromPcm16(tone(2, 0.1)))).toBe(true)
    // A click is too short to be a word.
    const click = new Int16Array(32000); click.fill(20000, 100, 800)
    expect(heardSomething(wavFromPcm16(click))).toBe(false)
  })

  test("the model's language and mood tags are dropped from the text", () => {
    expect(tidy("<|en|><|NEUTRAL|><|Speech|><|withitn|>Read the file.  ")).toBe("Read the file.")
    expect(tidy("  two   words ")).toBe("two words")
  })

  test("a long recording is cut where it is quietest", () => {
    const samples = new Float32Array(40 * 16000).fill(0.2)
    samples.fill(0, 22 * 16000, 22.4 * 16000)
    const cut = quietCut(samples, 0) / 16000
    expect(cut).toBeGreaterThan(22)
    expect(cut).toBeLessThan(22.4)
  })

  test("without the model it says what to do; the settings and the command are understood", () => {
    // Tests run on a throwaway profile, which has no speech model.
    if (!process.env.CG_VOICE_MODEL_DIR) expect(voiceProblem()).toMatch(/not set up yet: \/voice downloads|needs the sherpa-onnx-node package/)
    expect(normalise({}).voiceHold).toBe(true)
    expect(normalise({ voiceHold: false, voiceLanguage: "ja" })).toMatchObject({ voiceHold: false, voiceLanguage: "ja" })
    expect(normalise({ voiceLanguage: "klingon" }).voiceLanguage).toBe("auto")
    expect(runCommand("/voice")).toEqual({ kind: "voice", argument: "" })
    expect(runCommand("/voice Setup")).toEqual({ kind: "voice", argument: "setup" })
  })
})
