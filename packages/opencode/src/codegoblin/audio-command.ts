import fs from "fs/promises"
import os from "os"
import path from "path"

export type AudioCommandResult = {
  ok: boolean
  message: string
  output?: string
  model?: string
  provider?: string
}

type GenerateInput = {
  text: string
  output?: string
  model?: string
  voice?: string
  cwd: string
  dryRun?: boolean
  keyFile?: string
}

type Env = Record<string, string | undefined>

const DEFAULT_MODEL = "eleven_multilingual_v2"
const DEFAULT_VOICE = "21m00Tcm4TlvDq8ikWAM"
const DEFAULT_DIR = "codegoblin-output/audio"

export const CodeGoblinAudioCommand = {
  async generate(input: GenerateInput): Promise<AudioCommandResult> {
    return generateAudio(input)
  },
  describe(input: GenerateInput) {
    const root = path.resolve(input.cwd || process.cwd())
    return {
      provider: "elevenlabs",
      model: normalizeModel(input.model),
      voice: input.voice || process.env.ELEVENLABS_VOICE_ID || DEFAULT_VOICE,
      output: safeOutputPath(root, input.output),
    }
  },
}

async function generateAudio(input: GenerateInput): Promise<AudioCommandResult> {
  const root = path.resolve(input.cwd || process.cwd())
  const output = safeOutputPath(root, input.output)
  const model = normalizeModel(input.model)
  const voice = input.voice || process.env.ELEVENLABS_VOICE_ID || DEFAULT_VOICE

  if (input.dryRun) {
    return {
      ok: true,
      provider: "elevenlabs",
      model,
      output,
      message: `Audio dry run OK. CodeGoblin would generate with elevenlabs/${model}, voice ${voice}, and save to ${output}`,
    }
  }

  const env = await loadLocalEnv(root, input.keyFile)
  const key = env.ELEVENLABS_API_KEY || process.env.ELEVENLABS_API_KEY
  if (!key) {
    return {
      ok: false,
      provider: "elevenlabs",
      model,
      output,
      message: "No ElevenLabs key found. Set ELEVENLABS_API_KEY locally, then retry. CodeGoblin did not send this audio request.",
    }
  }

  const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice)}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "audio/mpeg",
      "xi-api-key": key,
    },
    body: JSON.stringify({
      text: input.text,
      model_id: model,
    }),
  })

  if (!response.ok) {
    const detail = await response.text().catch(() => "")
    return {
      ok: false,
      provider: "elevenlabs",
      model,
      output,
      message: `ElevenLabs audio request failed with HTTP ${response.status}${detail ? `: ${detail.slice(0, 220)}` : ""}`,
    }
  }

  await fs.mkdir(path.dirname(output), { recursive: true })
  await fs.writeFile(output, Buffer.from(await response.arrayBuffer()))
  return {
    ok: true,
    provider: "elevenlabs",
    model,
    output,
    message: `Audio generated with elevenlabs/${model} and saved to ${output}.`,
  }
}

function safeOutputPath(root: string, output?: string) {
  const target = path.resolve(root, output || path.join(DEFAULT_DIR, `${timestamp()}.mp3`))
  const rel = path.relative(root, target)
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error("Audio output path must stay inside the current project directory.")
  }
  return target
}

function normalizeModel(model?: string) {
  const raw = model?.trim()
  if (!raw) return DEFAULT_MODEL
  const lower = raw.toLowerCase().replace(/\s+/g, "-")
  if (lower === "elevenlabs-tts" || lower === "elevenlabs-v2.5-turbo" || lower === "eleven-turbo-v2.5") {
    return "eleven_turbo_v2_5"
  }
  if (lower === "elevenlabs-v3") return "eleven_v3"
  return raw
}

async function loadLocalEnv(root: string, keyFile?: string) {
  const result: Env = {}
  const files = [keyFile, ...envFilesUp(root)].filter((item): item is string => Boolean(item))
  for (const file of files) {
    const resolved = path.resolve(root, file)
    if (!resolved.startsWith(root) && file !== keyFile) continue
    const text = await fs.readFile(resolved, "utf8").catch(() => "")
    for (const line of text.split(/\r?\n/)) {
      const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line)
      if (!match || result[match[1]]) continue
      result[match[1]] = unquoteEnv(match[2])
    }
  }
  return result
}

function envFilesUp(root: string) {
  const result: string[] = []
  let current = root
  for (;;) {
    result.push(path.join(current, ".env.local"), path.join(current, ".env"))
    const parent = path.dirname(current)
    if (parent === current || current === os.homedir()) return result
    current = parent
  }
}

function unquoteEnv(value: string) {
  const trimmed = value.trim()
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-")
}