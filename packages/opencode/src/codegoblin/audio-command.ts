import fs from "fs/promises"
import os from "os"
import path from "path"

export type AudioCommandResult = {
  ok: boolean
  message: string
  output?: string
  model?: string
  provider?: string
  voice?: string
  outputFormat?: string
}

export type AudioVoiceSettings = {
  stability?: number
  similarityBoost?: number
  style?: number
  useSpeakerBoost?: boolean
  speed?: number
}

type GenerateInput = {
  text: string
  output?: string
  model?: string
  voice?: string
  outputFormat?: string
  voiceSettings?: AudioVoiceSettings
  languageCode?: string
  seed?: number
  applyTextNormalization?: "auto" | "on" | "off"
  applyLanguageTextNormalization?: boolean
  cwd: string
  dryRun?: boolean
  keyFile?: string
}

type Env = Record<string, string | undefined>

const DEFAULT_MODEL = "eleven_multilingual_v2"
const DEFAULT_VOICE = "21m00Tcm4TlvDq8ikWAM"
const AUTO_VOICE = "auto-generated account voice"
const DEFAULT_DIR = "codegoblin-output/audio"
const DEFAULT_OUTPUT_FORMAT = "mp3_44100_128"

export const CodeGoblinAudioCommand = {
  async generate(input: GenerateInput): Promise<AudioCommandResult> {
    return generateAudio(input)
  },
  describe(input: GenerateInput) {
    const root = path.resolve(input.cwd || process.cwd())
    return {
      provider: "elevenlabs",
      model: normalizeModel(input.model),
      voice: configuredVoice(input, process.env) || AUTO_VOICE,
      outputFormat: normalizeOutputFormat(input.outputFormat),
      output: safeOutputPath(root, input.output),
    }
  },
}

async function generateAudio(input: GenerateInput): Promise<AudioCommandResult> {
  const root = path.resolve(input.cwd || process.cwd())
  const env = await loadLocalEnv(root, input.keyFile)
  const output = safeOutputPath(root, input.output)
  const model = normalizeModel(input.model)
  const requestedVoice = configuredVoice(input, env)
  const dryRunVoice = requestedVoice || AUTO_VOICE
  const outputFormat = normalizeOutputFormat(input.outputFormat)
  const voiceSettings = normalizeVoiceSettings(input.voiceSettings)

  if (input.dryRun) {
    return {
      ok: true,
      provider: "elevenlabs",
      model,
      voice: dryRunVoice,
      outputFormat,
      output,
      message: `Audio dry run OK. CodeGoblin would generate with elevenlabs/${model}, voice ${dryRunVoice}, format ${outputFormat}, and save to ${output}`,
    }
  }

  const key = await findAudioKey(env)
  const voice = requestedVoice || (await findAccountGeneratedVoice(key?.value)) || DEFAULT_VOICE
  if (!key) {
    return {
      ok: false,
      provider: "elevenlabs",
      model,
      voice,
      outputFormat,
      output,
      message:
        "No ElevenLabs key found. Set ELEVENLABS_API_KEY or CODEGOBLIN_ELEVENLABS_API_KEY locally, or connect the ElevenLabs provider, then retry. CodeGoblin did not send this audio request.",
    }
  }

  const query = new URLSearchParams({ output_format: outputFormat })
  const body = {
    text: input.text,
    model_id: model,
    ...(input.languageCode ? { language_code: input.languageCode } : {}),
    ...(voiceSettings ? { voice_settings: voiceSettings } : {}),
    ...(input.seed !== undefined ? { seed: input.seed } : {}),
    ...(input.applyTextNormalization ? { apply_text_normalization: input.applyTextNormalization } : {}),
    ...(input.applyLanguageTextNormalization !== undefined
      ? { apply_language_text_normalization: input.applyLanguageTextNormalization }
      : {}),
  }

  const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice)}?${query}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: audioAccept(outputFormat),
      "xi-api-key": key.value,
    },
    body: JSON.stringify(body),
  })

  if (!response.ok) {
    const detail = await response.text().catch(() => "")
    return {
      ok: false,
      provider: "elevenlabs",
      model,
      voice,
      outputFormat,
      output,
      message: `ElevenLabs audio request failed with HTTP ${response.status}${detail ? `: ${detail.slice(0, 220)}` : ""}${requestedVoice ? "" : " If this account cannot use the fallback library voice, pass --voice or set ELEVENLABS_VOICE_ID to a generated voice from your ElevenLabs account."}`,
    }
  }

  await fs.mkdir(path.dirname(output), { recursive: true })
  await fs.writeFile(output, Buffer.from(await response.arrayBuffer()))
  return {
    ok: true,
    provider: "elevenlabs",
    model,
    voice,
    outputFormat,
    output,
    message: `Audio generated with elevenlabs/${model}, voice ${voice}, and saved to ${output}.`,
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
  if (lower === "elevenlabs-flash" || lower === "eleven-flash-v2.5" || lower === "elevenlabs-v2.5-flash") {
    return "eleven_flash_v2_5"
  }
  if (lower === "elevenlabs-v3") return "eleven_v3"
  return raw
}

function normalizeOutputFormat(outputFormat?: string) {
  return outputFormat?.trim() || DEFAULT_OUTPUT_FORMAT
}

function configuredVoice(input: Pick<GenerateInput, "voice">, env: Env) {
  return [input.voice, env.ELEVENLABS_VOICE_ID, env.CODEGOBLIN_ELEVENLABS_VOICE_ID]
    .map((item) => item?.trim())
    .find((item): item is string => Boolean(item))
}

async function findAccountGeneratedVoice(apiKey?: string) {
  if (!apiKey) return
  const response = await fetch("https://api.elevenlabs.io/v2/voices?page_size=50", {
    headers: {
      "xi-api-key": apiKey,
    },
  }).catch(() => undefined)
  if (!response?.ok) return
  const data = (await response.json().catch(() => undefined)) as { voices?: unknown } | undefined
  const voices = Array.isArray(data?.voices) ? data.voices : []
  return voices
    .map((item) => (item && typeof item === "object" ? (item as Record<string, unknown>) : undefined))
    .filter((item): item is Record<string, unknown> => Boolean(item))
    .filter((item) => item.category === "generated")
    .map((item) => (typeof item.voice_id === "string" ? item.voice_id : undefined))
    .find((item): item is string => Boolean(item))
}

function normalizeVoiceSettings(settings?: AudioVoiceSettings) {
  if (!settings) return
  const result = {
    ...(settings.stability !== undefined ? { stability: clamp(settings.stability, 0, 1) } : {}),
    ...(settings.similarityBoost !== undefined ? { similarity_boost: clamp(settings.similarityBoost, 0, 1) } : {}),
    ...(settings.style !== undefined ? { style: clamp(settings.style, 0, 1) } : {}),
    ...(settings.useSpeakerBoost !== undefined ? { use_speaker_boost: settings.useSpeakerBoost } : {}),
    ...(settings.speed !== undefined ? { speed: clamp(settings.speed, 0.7, 1.2) } : {}),
  }
  if (Object.keys(result).length === 0) return
  return result
}

function clamp(value: number, min: number, max: number) {
  if (Number.isNaN(value)) return min
  return Math.min(max, Math.max(min, value))
}

function audioAccept(outputFormat: string) {
  if (outputFormat.startsWith("wav_")) return "audio/wav"
  if (outputFormat.startsWith("pcm_")) return "application/octet-stream"
  if (outputFormat.startsWith("ulaw_")) return "audio/basic"
  return "audio/mpeg"
}

async function loadLocalEnv(root: string, keyFile?: string) {
  const result: Env = { ...process.env }
  const files = [
    process.env.CODEGOBLIN_ENV_FILE,
    process.env.CODEGOBLIN_ELEVENLABS_ENV_FILE,
    keyFile,
    ...envFilesUp(root),
  ].filter((item): item is string => Boolean(item))
  for (const file of files) {
    const resolved = path.resolve(root, file)
    const text = await fs.readFile(resolved, "utf8").catch(() => "")
    for (const line of text.split(/\r?\n/)) {
      const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line)
      if (!match || result[match[1]]) continue
      result[match[1]] = unquoteEnv(match[2])
    }
  }
  return result
}

async function findAudioKey(env: Env) {
  const local = ["ELEVENLABS_API_KEY", "CODEGOBLIN_ELEVENLABS_API_KEY"]
    .map((name) => (env[name] ? { value: env[name], source: name } : undefined))
    .filter((item): item is { value: string; source: string } => Boolean(item))[0]
  if (local) return local
  if (env.CODEGOBLIN_AUDIO_DISABLE_CONNECTED_AUTH === "1") return

  const key = await authKey("elevenlabs")
  if (!key) return
  return { value: key, source: "connected ElevenLabs provider" }
}

async function authKey(provider: string) {
  const file = path.join(os.homedir(), ".local", "share", "opencode", "auth.json")
  const raw = await fs.readFile(file, "utf8").catch(() => "")
  if (!raw) return
  try {
    const data = JSON.parse(raw)
    const item = data?.[provider]
    if (item?.type === "api" && typeof item.key === "string") return item.key
  } catch {}
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