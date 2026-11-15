/**
 * The speech engine, in a process of its own (see voice.ts).
 *
 * One request per line on stdin: { id, language, wav } with the WAV as base64. One answer per line on stdout:
 * { id, text } or { id, error }. The model loads on the first request and stays loaded until the process ends.
 */
import path from "node:path"
import { createRequire } from "node:module"
import { dataChunk, wavSeconds } from "./voice"

const dir = process.env.CG_VOICE_DIR || ""
const RATE = 16000
/** The model was trained on clips up to about half a minute; longer recordings are cut at a quiet moment. */
const MAX_PIECE = 28 * RATE
const MIN_PIECE = 18 * RATE

type Recognizer = {
  createStream: () => { acceptWaveform: (audio: { sampleRate: number; samples: Float32Array }) => void }
  decode: (stream: unknown) => void
  getResult: (stream: unknown) => { text?: string }
  setConfig: (config: unknown) => void
}
let recognizer: Recognizer | undefined
let config: { featConfig: object; modelConfig: { senseVoice: { model: string; language: string; useInverseTextNormalization: number }; tokens: string; numThreads: number; provider: string; debug: number } }

function engine(language: string): Recognizer {
  if (!recognizer) {
    const sherpa = createRequire(import.meta.url)("sherpa-onnx-node") as { OfflineRecognizer: new (config: unknown) => Recognizer }
    config = {
      featConfig: { sampleRate: RATE, featureDim: 80 },
      modelConfig: {
        senseVoice: { model: path.join(dir, "model.int8.onnx"), language, useInverseTextNormalization: 1 },
        tokens: path.join(dir, "tokens.txt"), numThreads: 4, provider: "cpu", debug: 0,
      },
    }
    recognizer = new sherpa.OfflineRecognizer(config)
  } else if (config.modelConfig.senseVoice.language !== language) {
    config.modelConfig.senseVoice.language = language
    recognizer.setConfig(config)
  }
  return recognizer
}

/** Where to cut a long recording: the quietest fifth of a second between the shortest and longest piece allowed. */
export function quietCut(samples: Float32Array, from: number): number {
  const window = RATE / 5
  let best = from + MAX_PIECE, least = Infinity
  for (let at = from + MIN_PIECE; at + window <= Math.min(samples.length, from + MAX_PIECE); at += window / 2) {
    let energy = 0
    for (let i = at; i < at + window; i++) energy += samples[i]! * samples[i]!
    if (energy < least) { least = energy; best = at + window / 2 }
  }
  return Math.min(best, samples.length)
}

function recognise(wav: Uint8Array, language: string): string {
  wavSeconds(wav)
  const { offset, length } = dataChunk(wav)
  const pcm = new DataView(wav.buffer, wav.byteOffset + offset, length)
  const samples = Float32Array.from({ length: length / 2 }, (_, i) => pcm.getInt16(i * 2, true) / 32768)
  const using = engine(language)
  const parts: string[] = []
  for (let from = 0; from < samples.length;) {
    const to = samples.length - from <= MAX_PIECE ? samples.length : quietCut(samples, from)
    const stream = using.createStream()
    stream.acceptWaveform({ sampleRate: RATE, samples: samples.subarray(from, to) })
    using.decode(stream)
    parts.push(String(using.getResult(stream).text ?? "").trim())
    from = to
  }
  return parts.filter(Boolean).join(" ")
}

if (import.meta.main) {
  let buffer = ""
  const decoder = new TextDecoder()
  for await (const chunk of Bun.stdin.stream()) {
    buffer += decoder.decode(chunk, { stream: true })
    for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
      const line = buffer.slice(0, end)
      buffer = buffer.slice(end + 1)
      if (!line.trim()) continue
      let id: number | undefined
      try {
        const request = JSON.parse(line) as { id: number; language?: string; wav: string }
        id = request.id
        const text = recognise(new Uint8Array(Buffer.from(request.wav, "base64")), request.language || "auto")
        process.stdout.write(JSON.stringify({ id, text }) + "\n")
      } catch (error) {
        process.stdout.write(JSON.stringify({ id, error: error instanceof Error ? error.message : String(error) }) + "\n")
      }
    }
  }
}
