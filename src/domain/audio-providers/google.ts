import {
  type AudioGenerateOutput,
  type AudioGenerateRequest,
  type AudioProvider,
  type AudioVoiceOption,
  type AudioVoicesOutput,
  clampNumber,
} from "./types"

const DEFAULT_MODEL = "neural2"
const DEFAULT_OUTPUT_FORMAT = "MP3"
const DEFAULT_LANGUAGE = "en-US"

const MODEL_ALIASES: Record<string, string> = {
  "google-tts": "neural2",
  "google-cloud-tts": "neural2",
  standard: "standard",
  wavenet: "wavenet",
  neural2: "neural2",
  "neural-2": "neural2",
  studio: "studio",
  "chirp3-hd": "chirp3-hd",
  "chirp-3-hd": "chirp3-hd",
}

export const GoogleAudioProvider: AudioProvider = {
  id: "google",
  name: "Google Cloud TTS",
  defaultModel: DEFAULT_MODEL,
  defaultOutputFormat: DEFAULT_OUTPUT_FORMAT,
  envKeys: ["GOOGLE_CLOUD_TTS_API_KEY", "CODEGOBLIN_GOOGLE_TTS_API_KEY", "GOOGLE_API_KEY"],
  authProviderID: "google",
  models: [
    { id: "neural2", name: "Neural2" },
    { id: "wavenet", name: "WaveNet" },
    { id: "studio", name: "Studio" },
    { id: "chirp3-hd", name: "Chirp 3 HD" },
    { id: "standard", name: "Standard" },
  ],
  outputFormats: ["MP3", "LINEAR16", "OGG_OPUS", "MULAW", "ALAW"],
  fileExtension(outputFormat) {
    switch (outputFormat.toUpperCase()) {
      case "LINEAR16":
        return "wav"
      case "OGG_OPUS":
        return "ogg"
      case "MULAW":
        return "ulaw"
      case "ALAW":
        return "alaw"
      default:
        return "mp3"
    }
  },
  normalizeModel(model) {
    const raw = model?.trim().toLowerCase()
    if (!raw) return DEFAULT_MODEL
    return MODEL_ALIASES[raw] ?? raw
  },
  async resolveDefaultVoice(request, apiKey) {
    if (request.voice) return request.voice
    const languageCode = request.languageCode || DEFAULT_LANGUAGE
    const list = await fetchGoogleVoices(apiKey, languageCode)
    if (!list.ok) return undefined
    // Prefer a Neural2 voice for the requested language, else the first available voice.
    const preferred =
      list.voices.find((voice) => voice.id.includes("Neural2")) ?? list.voices[0]
    return preferred?.id
  },
  async generate(request: AudioGenerateRequest): Promise<AudioGenerateOutput> {
    const languageCode = request.languageCode || languageFromVoice(request.voice) || DEFAULT_LANGUAGE
    const audioConfig: Record<string, unknown> = { audioEncoding: request.outputFormat.toUpperCase() }
    if (request.voiceSettings?.speed !== undefined) {
      audioConfig.speakingRate = clampNumber(request.voiceSettings.speed, 0.25, 4)
    }
    const body = {
      input: { text: request.text },
      voice: {
        languageCode,
        ...(request.voice ? { name: request.voice } : {}),
      },
      audioConfig,
    }

    const response = await fetch(
      `https://texttospeech.googleapis.com/v1/text:synthesize?key=${encodeURIComponent(request.apiKey)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    ).catch(() => undefined)

    if (!response) return { ok: false, message: "Could not reach Google Cloud Text-to-Speech API." }
    if (!response.ok) {
      const detail = await response.text().catch(() => "")
      return {
        ok: false,
        message: `Google Cloud TTS request failed with HTTP ${response.status}${detail ? `: ${detail.slice(0, 220)}` : ""}`,
      }
    }

    const data = (await response.json().catch(() => undefined)) as { audioContent?: unknown } | undefined
    if (typeof data?.audioContent !== "string") {
      return { ok: false, message: "Google Cloud TTS did not return audio content." }
    }
    return { ok: true, audio: new Uint8Array(Buffer.from(data.audioContent, "base64")), voice: request.voice || languageCode }
  },
  async voices(apiKey): Promise<AudioVoicesOutput> {
    return fetchGoogleVoices(apiKey)
  },
}

function languageFromVoice(voice?: string) {
  if (!voice) return undefined
  const match = /^([a-z]{2}-[A-Z]{2})/.exec(voice)
  return match?.[1]
}

async function fetchGoogleVoices(apiKey: string, languageCode?: string): Promise<AudioVoicesOutput> {
  const query = new URLSearchParams({ key: apiKey })
  if (languageCode) query.set("languageCode", languageCode)
  const response = await fetch(`https://texttospeech.googleapis.com/v1/voices?${query}`).catch(() => undefined)
  if (!response) return { ok: false, message: "Could not reach Google Cloud Text-to-Speech voices API." }
  if (!response.ok) {
    const detail = await response.text().catch(() => "")
    return {
      ok: false,
      message: `Google Cloud TTS voices request failed with HTTP ${response.status}${detail ? `: ${detail.slice(0, 220)}` : ""}`,
    }
  }

  const data = (await response.json().catch(() => undefined)) as { voices?: unknown } | undefined
  return {
    ok: true,
    voices: (Array.isArray(data?.voices) ? data.voices : [])
      .map((item) => (item && typeof item === "object" ? toGoogleVoiceOption(item as Record<string, unknown>) : undefined))
      .filter((item): item is AudioVoiceOption => Boolean(item)),
  }
}

function toGoogleVoiceOption(input: Record<string, unknown>): AudioVoiceOption | undefined {
  if (typeof input.name !== "string") return
  const languageCodes = Array.isArray(input.languageCodes)
    ? input.languageCodes.filter((code): code is string => typeof code === "string")
    : []
  const labels: Record<string, string> = {}
  if (typeof input.ssmlGender === "string") labels.gender = input.ssmlGender
  if (languageCodes.length > 0) labels.language = languageCodes.join(", ")
  return {
    id: input.name,
    name: input.name,
    ...(languageCodes.length > 0 ? { category: languageCodes[0] } : {}),
    ...(Object.keys(labels).length > 0 ? { labels } : {}),
  }
}
