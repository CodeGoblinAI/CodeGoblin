import {
  type AudioGenerateOutput,
  type AudioGenerateRequest,
  type AudioProvider,
  type AudioVoiceOption,
  type AudioVoiceSettings,
  type AudioVoicesOutput,
  clampNumber,
} from "./types"

const DEFAULT_MODEL = "eleven_multilingual_v2"
const DEFAULT_VOICE = "21m00Tcm4TlvDq8ikWAM"
const DEFAULT_OUTPUT_FORMAT = "mp3_44100_128"

export const ElevenLabsAudioProvider: AudioProvider = {
  id: "elevenlabs",
  name: "ElevenLabs",
  defaultModel: DEFAULT_MODEL,
  defaultOutputFormat: DEFAULT_OUTPUT_FORMAT,
  envKeys: ["ELEVENLABS_API_KEY", "CODEGOBLIN_ELEVENLABS_API_KEY"],
  authProviderID: "elevenlabs",
  models: [
    { id: "eleven_multilingual_v2", name: "Multilingual v2" },
    { id: "eleven_turbo_v2_5", name: "Turbo v2.5" },
    { id: "eleven_flash_v2_5", name: "Flash v2.5" },
    { id: "eleven_v3", name: "Eleven v3" },
  ],
  outputFormats: [
    "mp3_44100_128",
    "mp3_44100_192",
    "mp3_22050_32",
    "pcm_16000",
    "pcm_24000",
    "pcm_44100",
    "ulaw_8000",
  ],
  fileExtension(outputFormat) {
    if (outputFormat.startsWith("wav_")) return "wav"
    if (outputFormat.startsWith("pcm_")) return "pcm"
    if (outputFormat.startsWith("ulaw_")) return "ulaw"
    return "mp3"
  },
  normalizeModel(model) {
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
  },
  async resolveDefaultVoice(request, apiKey) {
    if (request.voice) return request.voice
    const generated = await findAccountGeneratedVoice(apiKey)
    return generated ?? DEFAULT_VOICE
  },
  async generate(request: AudioGenerateRequest): Promise<AudioGenerateOutput> {
    const voice = request.voice || DEFAULT_VOICE
    const query = new URLSearchParams({ output_format: request.outputFormat })
    const body = {
      text: request.text,
      model_id: request.model,
      ...(request.languageCode ? { language_code: request.languageCode } : {}),
      ...(normalizeVoiceSettings(request.voiceSettings)
        ? { voice_settings: normalizeVoiceSettings(request.voiceSettings) }
        : {}),
      ...(request.seed !== undefined ? { seed: request.seed } : {}),
      ...(request.applyTextNormalization ? { apply_text_normalization: request.applyTextNormalization } : {}),
      ...(request.applyLanguageTextNormalization !== undefined
        ? { apply_language_text_normalization: request.applyLanguageTextNormalization }
        : {}),
    }

    const response = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice)}?${query}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: audioAccept(request.outputFormat),
          "xi-api-key": request.apiKey,
        },
        body: JSON.stringify(body),
      },
    )

    if (!response.ok) {
      const detail = await response.text().catch(() => "")
      return {
        ok: false,
        message: `ElevenLabs audio request failed with HTTP ${response.status}${detail ? `: ${detail.slice(0, 220)}` : ""}. If this account cannot use the fallback library voice, pass --voice or set ELEVENLABS_VOICE_ID to a generated voice from your ElevenLabs account.`,
      }
    }

    return { ok: true, audio: new Uint8Array(await response.arrayBuffer()), voice }
  },
  async voices(apiKey): Promise<AudioVoicesOutput> {
    return fetchElevenLabsVoices(apiKey)
  },
}

async function findAccountGeneratedVoice(apiKey?: string) {
  if (!apiKey) return
  const response = await fetchElevenLabsVoices(apiKey)
  if (!response.ok) return
  return response.voices
    .filter((item) => item.category === "generated")
    .map((item) => item.id)
    .find((item) => Boolean(item))
}

async function fetchElevenLabsVoices(apiKey: string): Promise<AudioVoicesOutput> {
  const response = await fetch("https://api.elevenlabs.io/v2/voices?page_size=100", {
    headers: { "xi-api-key": apiKey },
  }).catch(() => undefined)
  if (!response) return { ok: false, message: "Could not reach ElevenLabs voices API." }
  if (!response.ok) {
    const detail = await response.text().catch(() => "")
    return {
      ok: false,
      message: `ElevenLabs voices request failed with HTTP ${response.status}${detail ? `: ${detail.slice(0, 220)}` : ""}`,
    }
  }

  const data = (await response.json().catch(() => undefined)) as { voices?: unknown } | undefined
  return {
    ok: true,
    voices: (Array.isArray(data?.voices) ? data.voices : [])
      .map((item) => (item && typeof item === "object" ? toAudioVoiceOption(item as Record<string, unknown>) : undefined))
      .filter((item): item is AudioVoiceOption => Boolean(item)),
  }
}

function toAudioVoiceOption(input: Record<string, unknown>): AudioVoiceOption | undefined {
  if (typeof input.voice_id !== "string") return
  const labels =
    input.labels && typeof input.labels === "object"
      ? Object.fromEntries(
          Object.entries(input.labels as Record<string, unknown>).filter(
            (entry): entry is [string, string] => typeof entry[1] === "string",
          ),
        )
      : undefined
  return {
    id: input.voice_id,
    name: typeof input.name === "string" && input.name.trim() ? input.name : input.voice_id,
    ...(typeof input.category === "string" ? { category: input.category } : {}),
    ...(typeof input.description === "string" ? { description: input.description } : {}),
    ...(typeof input.preview_url === "string" ? { previewUrl: input.preview_url } : {}),
    ...(labels && Object.keys(labels).length > 0 ? { labels } : {}),
  }
}

function normalizeVoiceSettings(settings?: AudioVoiceSettings) {
  if (!settings) return
  const result = {
    ...(settings.stability !== undefined ? { stability: clampNumber(settings.stability, 0, 1) } : {}),
    ...(settings.similarityBoost !== undefined ? { similarity_boost: clampNumber(settings.similarityBoost, 0, 1) } : {}),
    ...(settings.style !== undefined ? { style: clampNumber(settings.style, 0, 1) } : {}),
    ...(settings.useSpeakerBoost !== undefined ? { use_speaker_boost: settings.useSpeakerBoost } : {}),
    ...(settings.speed !== undefined ? { speed: clampNumber(settings.speed, 0.7, 1.2) } : {}),
  }
  if (Object.keys(result).length === 0) return
  return result
}

function audioAccept(outputFormat: string) {
  if (outputFormat.startsWith("wav_")) return "audio/wav"
  if (outputFormat.startsWith("pcm_")) return "application/octet-stream"
  if (outputFormat.startsWith("ulaw_")) return "audio/basic"
  return "audio/mpeg"
}
