import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createHash } from "node:crypto"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import { Global } from "../platform/paths"
import { downloadModel, cancelDownload, type CatalogEntry, type Progress } from "./local-downloads"

/**
 * Voice input: speech turned into text on this machine, for the prompt box.
 *
 * SenseVoice Small through sherpa-onnx, on the CPU: no Python, no account, and the recording never leaves
 * the computer. The approach is DeepSeek Harness's (its experimental voice bundle); the pieces here are ours:
 * the model is pinned to an exact revision, size and SHA-256 like the local chat models, and recognition runs
 * in its own process so loading a 230 MB model never freezes the terminal.
 *
 * What it is not: live captions. A recording is transcribed when it ends, and the text goes into the prompt
 * box to be read before it is sent.
 */
const REPO = "csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17"
const REVISION = "2365baeacb507f821a0c8120fcee3d484dba7a07"
export const VOICE_ASSETS: CatalogEntry[] = [
  { id: "voice-tokens", label: "speech model vocabulary", repo: REPO, revision: REVISION, file: "tokens.txt", bytes: 315_894,
    sha256: "f449eb28dc567533d7fa59be34e2abca8784f771850c78a47fb731a31429a1dc", about: "tokens" },
  { id: "voice-model", label: "speech model (SenseVoice Small)", repo: REPO, revision: REVISION, file: "model.int8.onnx", bytes: 239_233_841,
    sha256: "c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51", about: "recognition weights" },
]
export const VOICE_BYTES = VOICE_ASSETS.reduce((sum, asset) => sum + asset.bytes, 0)
/** Languages the model takes a hint for; "auto" lets it tell. */
export const VOICE_LANGUAGES = ["auto", "en", "zh", "yue", "ja", "ko"] as const
/** What to tell someone before they download, in plain numbers. */
export const VOICE_NEEDS = { download: "229 MB", disk: "about 250 MB", memory: "about 1 GB while it is listening or has just been used", time: "a few minutes (about four on a typical connection)" }

/** Where the model is kept. CG_VOICE_MODEL_DIR points at an existing copy instead (it is not verified). */
export const voiceDir = () => process.env.CG_VOICE_MODEL_DIR || path.join(Global.Path.data, "voice", "sensevoice")

/** The speech engine is an optional package: present after a normal install on a supported machine. */
export function voiceRuntime(): boolean {
  try {
    createRequire(import.meta.url).resolve("sherpa-onnx-node")
    return true
  } catch {
    return false
  }
}

const present = (asset: CatalogEntry) => {
  try {
    return fs.statSync(path.join(voiceDir(), asset.file)).size === asset.bytes
  } catch {
    return false
  }
}

export type VoiceState = {
  /** Ready to transcribe: the engine is installed and the model is on disk. */
  ready: boolean
  runtime: boolean
  model: boolean
  dir: string
  /** A download in progress. */
  preparing?: { label: string; received: number; total: number }
  /** How the last setup ended, when it did not end well. */
  problem?: string
}

let preparing: { label: string; received: number; total: number } | undefined
let problem: string | undefined

export function voiceState(): VoiceState {
  const runtime = voiceRuntime()
  const model = VOICE_ASSETS.every(present)
  return { ready: runtime && model, runtime, model, dir: voiceDir(), ...(preparing ? { preparing } : {}), ...(problem && !model ? { problem } : {}) }
}

/** Why voice cannot be used yet, as a sentence, or nothing when it can. */
export function voiceProblem(state = voiceState()): string | undefined {
  if (!state.runtime) return "Voice input needs the sherpa-onnx-node package, which is not installed here (run bun install in CG-Next; it supports Windows x64, macOS and Linux x64/arm64)."
  if (state.preparing) return "The speech model is still downloading."
  if (!state.model) return "Voice input is not set up yet: /voice downloads the speech model (" + VOICE_NEEDS.download + ")."
  return undefined
}

async function sha256Of(file: string): Promise<string> {
  const hash = createHash("sha256")
  await new Promise<void>((resolve, reject) => fs.createReadStream(file).on("data", (chunk) => hash.update(chunk)).on("end", resolve).on("error", reject))
  return hash.digest("hex")
}

/** A copy another app already downloaded (DeepSeek Harness keeps the same file); used only if its bytes match. */
const elsewhere = (asset: CatalogEntry) => path.join(os.homedir(), ".dsh", "speech-to-text", "sensevoice", "models", "sensevoice-onnx", asset.file)

/**
 * Gets the model onto disk: verified, resumable, one file at a time. A matching copy already on this
 * machine is copied rather than downloaded again. Resolves when voice is ready; rejects with a sentence.
 */
export async function prepareVoice(options: { onProgress?: (state: VoiceState) => void; signal?: AbortSignal; fetch?: (url: URL, init: RequestInit) => Promise<Response>; reuse?: boolean } = {}): Promise<void> {
  if (process.env.CG_VOICE_MODEL_DIR) throw new Error("CG_VOICE_MODEL_DIR is set, so the model there is used as it is; nothing to download.")
  if (preparing) throw new Error("The speech model is already downloading.")
  problem = undefined
  const dir = voiceDir()
  const total = VOICE_BYTES
  let before = 0
  try {
    fs.mkdirSync(dir, { recursive: true })
    for (const asset of VOICE_ASSETS) {
      preparing = { label: asset.label, received: before, total }
      options.onProgress?.(voiceState())
      if (!present(asset)) {
        const other = elsewhere(asset)
        let copied = false
        if (options.reuse !== false && fs.existsSync(other) && fs.statSync(other).size === asset.bytes && (await sha256Of(other)) === asset.sha256) {
          const part = path.join(dir, asset.file + ".copy")
          await fs.promises.copyFile(other, part)
          fs.renameSync(part, path.join(dir, asset.file))
          copied = true
        }
        if (!copied) {
          await downloadModel(asset, {
            dir, headroom: 200 * 1024 ** 2, signal: options.signal, ...(options.fetch ? { fetch: options.fetch } : {}),
            onProgress: (progress: Progress) => { preparing = { label: asset.label, received: before + progress.received, total }; options.onProgress?.(voiceState()) },
          })
        }
      }
      before += asset.bytes
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    problem = /cancel|abort/i.test(message) ? "Stopped. What was downloaded is kept, and setting up again carries on from there." : message.replace(/ ?\/local pull \S+ resumes it\.?| Pick it under Local models\.| ?\/local cancel stops it\.?/g, "")
    throw new Error(problem)
  } finally {
    preparing = undefined
    options.onProgress?.(voiceState())
  }
}

/** Stops a model download in progress. */
export const cancelVoiceSetup = () => (preparing ? cancelDownload() : false)

// --- recognition, in its own process ---------------------------------------------------------------------

type Pending = { resolve: (text: string) => void; reject: (error: Error) => void }
let worker: { proc: ReturnType<typeof Bun.spawn>; pending: Map<number, Pending>; idle?: ReturnType<typeof setTimeout> } | undefined
let nextId = 1
/** The engine is let go after this long unused; the model stays on disk and loads again in about a second. */
const IDLE_MS = 5 * 60_000

function startWorker() {
  const proc = Bun.spawn([process.execPath, fileURLToPath(new URL("./voice-worker.ts", import.meta.url))], {
    stdin: "pipe", stdout: "pipe", stderr: "ignore", windowsHide: true,
    env: { ...process.env, CG_VOICE_DIR: voiceDir() },
  })
  const pending = new Map<number, Pending>()
  const mine = { proc, pending } as NonNullable<typeof worker>
  const fail = (reason: string) => {
    for (const each of pending.values()) each.reject(new Error(reason))
    pending.clear()
    if (worker === mine) worker = undefined
  }
  void (async () => {
    let buffer = ""
    const decoder = new TextDecoder()
    try {
      for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) {
        buffer += decoder.decode(chunk, { stream: true })
        for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
          const line = buffer.slice(0, end)
          buffer = buffer.slice(end + 1)
          let reply: { id?: number; text?: string; error?: string }
          try { reply = JSON.parse(line) } catch { continue }
          const waiting = reply.id === undefined ? undefined : pending.get(reply.id)
          if (!waiting) continue
          pending.delete(reply.id!)
          if (typeof reply.text === "string") waiting.resolve(reply.text)
          else waiting.reject(new Error(reply.error || "the speech engine gave no answer"))
        }
      }
    } catch {}
    fail("the speech engine stopped unexpectedly")
  })()
  return mine
}

/** Loads the speech engine ahead of the first recording, so that one is not kept waiting. */
export function warmVoice() {
  if (!worker && voiceState().ready) worker = startWorker()
}

/**
 * Text for a recording: 16 kHz, mono, 16-bit PCM WAV. The audio is handed to the engine in memory and
 * is not written anywhere.
 */
export async function transcribe(wav: Uint8Array, language: string = "auto", signal?: AbortSignal): Promise<string> {
  const why = voiceProblem()
  if (why) throw new Error(why)
  const seconds = wavSeconds(wav)
  // Silence is not sent to the model: handed a quiet recording it invents a word ("Okay.").
  if (seconds < 0.3 || !heardSomething(wav)) return ""
  worker ??= startWorker()
  const using = worker
  if (using.idle) clearTimeout(using.idle)
  const id = nextId++
  const text = await new Promise<string>((resolve, reject) => {
    using.pending.set(id, { resolve, reject })
    const stop = () => { using.pending.delete(id); reject(new Error("cancelled")) }
    signal?.addEventListener("abort", stop, { once: true })
    try {
      const stdin = using.proc.stdin as { write: (text: string) => void; flush?: () => void }
      stdin.write(JSON.stringify({ id, language: (VOICE_LANGUAGES as readonly string[]).includes(language) ? language : "auto", wav: Buffer.from(wav).toString("base64") }) + "\n")
      stdin.flush?.()
    } catch (error) {
      using.pending.delete(id)
      reject(error instanceof Error ? error : new Error(String(error)))
    }
  })
  if (worker === using && !using.pending.size) using.idle = setTimeout(stopVoice, IDLE_MS)
  return tidy(text)
}

/** Ends the speech engine's process; the next recording starts it again. */
export function stopVoice() {
  if (!worker) return
  const gone = worker
  worker = undefined
  if (gone.idle) clearTimeout(gone.idle)
  try { gone.proc.kill() } catch {}
}

/** The model marks language and mood (<|en|><|NEUTRAL|>…); only the words are wanted. */
export const tidy = (text: string) => text.replace(/<\|[^|>]*\|>/g, "").replace(/\s+/g, " ").trim()

// --- WAV ------------------------------------------------------------------------------------------------

/** Seconds of audio in a canonical 16 kHz mono PCM16 WAV; throws on anything else. */
export function wavSeconds(wav: Uint8Array): number {
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength)
  const tag = (at: number) => String.fromCharCode(wav[at]!, wav[at + 1]!, wav[at + 2]!, wav[at + 3]!)
  if (wav.byteLength < 44 || tag(0) !== "RIFF" || tag(8) !== "WAVE") throw new Error("That is not a WAV recording.")
  const data = dataChunk(wav)
  if (view.getUint16(20, true) !== 1 || view.getUint16(22, true) !== 1 || view.getUint32(24, true) !== 16000 || view.getUint16(34, true) !== 16) {
    throw new Error("The recording has to be 16 kHz, mono, 16-bit.")
  }
  return data.length / 2 / 16000
}

/** Where the samples are. Recorders differ in what they put before them (LIST, fact), so the chunk is found, not assumed at 44. */
export function dataChunk(wav: Uint8Array): { offset: number; length: number } {
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength)
  for (let at = 12; at + 8 <= wav.byteLength;) {
    const size = view.getUint32(at + 4, true)
    if (wav[at] === 0x64 && wav[at + 1] === 0x61 && wav[at + 2] === 0x74 && wav[at + 3] === 0x61) {
      return { offset: at + 8, length: Math.min(size, wav.byteLength - at - 8) & ~1 }
    }
    at += 8 + size + (size & 1)
  }
  throw new Error("The recording has no audio in it.")
}

/**
 * Whether anyone spoke: at least a fifth of a second, in all, of 20 ms frames louder than a quiet room.
 * A muted or missing microphone records zeros, and a quiet room a faint hiss; neither is speech.
 */
export function heardSomething(wav: Uint8Array): boolean {
  const { offset, length } = dataChunk(wav)
  const view = new DataView(wav.buffer, wav.byteOffset + offset, length)
  const frame = 320
  let loud = 0
  for (let at = 0; at + frame * 2 <= length; at += frame * 2) {
    let energy = 0
    for (let i = 0; i < frame; i++) { const sample = view.getInt16(at + i * 2, true) / 32768; energy += sample * sample }
    if (Math.sqrt(energy / frame) > 0.012) loud++
  }
  return loud >= 10
}

/** A canonical WAV around 16 kHz mono samples. */
export function wavFromPcm16(samples: Int16Array): Uint8Array {
  const out = new Uint8Array(44 + samples.length * 2)
  const view = new DataView(out.buffer)
  const put = (at: number, text: string) => { for (let i = 0; i < text.length; i++) out[at + i] = text.charCodeAt(i) }
  put(0, "RIFF"); view.setUint32(4, 36 + samples.length * 2, true); put(8, "WAVE"); put(12, "fmt ")
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, 16000, true)
  view.setUint32(28, 32000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true); put(36, "data"); view.setUint32(40, samples.length * 2, true)
  for (let i = 0; i < samples.length; i++) view.setInt16(44 + i * 2, samples[i]!, true)
  return out
}
