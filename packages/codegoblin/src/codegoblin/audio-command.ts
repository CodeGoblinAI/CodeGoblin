import fs from "fs/promises"
import os from "os"
import path from "path"
import { Global } from "@codegoblin/core/global"
import { getAudioProvider } from "./audio-providers"
import type { AudioVoiceOption, AudioVoiceSettings } from "./audio-providers"

export type { AudioVoiceOption, AudioVoiceSettings } from "./audio-providers"

export type AudioCommandResult = {
  ok: boolean
  message: string
  output?: string
  model?: string
  provider?: string
  voice?: string
  outputFormat?: string
}

type GenerateInput = {
  text: string
  provider?: string
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

type VoicesInput = Pick<GenerateInput, "cwd" | "keyFile" | "provider">

type Env = Record<string, string | undefined>

const AUTO_VOICE = "auto-generated account voice"
const DEFAULT_DIR = "codegoblin-output/audio"

export const CodeGoblinAudioCommand = {
  async generate(input: GenerateInput): Promise<AudioCommandResult> {
    return generateAudio(input)
  },
  async voices(input: VoicesInput) {
    return listVoices(input)
  },
  describe(input: GenerateInput) {
    const provider = getAudioProvider(input.provider)
    const root = path.resolve(input.cwd || process.cwd())
    const outputFormat = normalizeOutputFormat(provider, input.outputFormat)
    return {
      provider: provider.id,
      model: provider.normalizeModel(input.model),
      voice: configuredVoice(input, process.env) || AUTO_VOICE,
      outputFormat,
      output: safeOutputPath(root, input.output, provider.fileExtension(outputFormat)),
    }
  },
}

async function generateAudio(input: GenerateInput): Promise<AudioCommandResult> {
  const provider = getAudioProvider(input.provider)
  const root = path.resolve(input.cwd || process.cwd())
  const env = await loadLocalEnv(root, input.keyFile)
  const outputFormat = normalizeOutputFormat(provider, input.outputFormat)
  const output = safeOutputPath(root, input.output, provider.fileExtension(outputFormat))
  const model = provider.normalizeModel(input.model)
  const requestedVoice = configuredVoice(input, env)
  const dryRunVoice = requestedVoice || AUTO_VOICE

  if (input.dryRun) {
    return {
      ok: true,
      provider: provider.id,
      model,
      voice: dryRunVoice,
      outputFormat,
      output,
      message: `Audio dry run OK. CodeGoblin would generate with ${provider.id}/${model}, voice ${dryRunVoice}, format ${outputFormat}, and save to ${output}`,
    }
  }

  const key = await findAudioKey(env, provider.envKeys, provider.authProviderID)
  if (!key) {
    return {
      ok: false,
      provider: provider.id,
      model,
      voice: requestedVoice || AUTO_VOICE,
      outputFormat,
      output,
      message: `No ${provider.name} key found. Set ${provider.envKeys.join(" or ")} locally${
        provider.authProviderID ? `, or connect the ${provider.name} provider,` : ""
      } then retry. CodeGoblin did not send this audio request.`,
    }
  }

  const voice = await provider.resolveDefaultVoice(
    { voice: requestedVoice, languageCode: input.languageCode },
    key.value,
  )
  const result = await provider.generate({
    text: input.text,
    model,
    voice,
    outputFormat,
    voiceSettings: input.voiceSettings,
    languageCode: input.languageCode,
    seed: input.seed,
    applyTextNormalization: input.applyTextNormalization,
    applyLanguageTextNormalization: input.applyLanguageTextNormalization,
    apiKey: key.value,
  })

  if (!result.ok) {
    return {
      ok: false,
      provider: provider.id,
      model,
      voice: voice || requestedVoice || AUTO_VOICE,
      outputFormat,
      output,
      message: result.message,
    }
  }

  await fs.mkdir(path.dirname(output), { recursive: true })
  await fs.writeFile(output, Buffer.from(result.audio))
  return {
    ok: true,
    provider: provider.id,
    model,
    voice: result.voice,
    outputFormat,
    output,
    message: `Audio generated with ${provider.id}/${model}, voice ${result.voice}, and saved to ${output}.`,
  }
}

async function listVoices(input: VoicesInput) {
  const provider = getAudioProvider(input.provider)
  const root = path.resolve(input.cwd || process.cwd())
  const key = await findAudioKey(await loadLocalEnv(root, input.keyFile), provider.envKeys, provider.authProviderID)
  if (!key) {
    return {
      ok: false as const,
      voices: [] as AudioVoiceOption[],
      message: `No ${provider.name} key found. Set ${provider.envKeys.join(" or ")} locally${
        provider.authProviderID ? `, or connect the ${provider.name} provider,` : ""
      } then retry.`,
    }
  }

  const response = await provider.voices(key.value)
  if (!response.ok) {
    return { ok: false as const, voices: [] as AudioVoiceOption[], message: response.message }
  }
  return { ok: true as const, voices: response.voices }
}

function safeOutputPath(root: string, output: string | undefined, extension: string) {
  const target = path.resolve(root, output || path.join(DEFAULT_DIR, `${timestamp()}.${extension}`))
  const rel = path.relative(root, target)
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error("Audio output path must stay inside the current project directory.")
  }
  return target
}

function normalizeOutputFormat(provider: { defaultOutputFormat: string }, outputFormat?: string) {
  return outputFormat?.trim() || provider.defaultOutputFormat
}

function configuredVoice(input: Pick<GenerateInput, "voice">, env: Env) {
  return [input.voice, env.ELEVENLABS_VOICE_ID, env.CODEGOBLIN_ELEVENLABS_VOICE_ID, env.CODEGOBLIN_AUDIO_VOICE_ID]
    .map((item) => item?.trim())
    .find((item): item is string => Boolean(item))
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

async function findAudioKey(env: Env, envKeys: string[], authProviderID?: string) {
  const local = envKeys
    .map((name) => (env[name] ? { value: env[name] as string, source: name } : undefined))
    .filter((item): item is { value: string; source: string } => Boolean(item))[0]
  if (local) return local
  if (env.CODEGOBLIN_AUDIO_DISABLE_CONNECTED_AUTH === "1" || !authProviderID) return

  const key = await authKey(authProviderID)
  if (!key) return
  return { value: key, source: `connected ${authProviderID} provider` }
}

async function authKey(provider: string) {
  const file = path.join(Global.Path.data, "auth.json")
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