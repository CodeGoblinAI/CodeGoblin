export type AudioVoiceSettings = {
  stability?: number
  similarityBoost?: number
  style?: number
  useSpeakerBoost?: boolean
  speed?: number
}

export type AudioVoiceOption = {
  id: string
  name: string
  category?: string
  description?: string
  previewUrl?: string
  labels?: Record<string, string>
}

export type AudioProviderModel = {
  id: string
  name: string
}

export type AudioGenerateRequest = {
  text: string
  model: string
  voice?: string
  outputFormat: string
  voiceSettings?: AudioVoiceSettings
  languageCode?: string
  seed?: number
  applyTextNormalization?: "auto" | "on" | "off"
  applyLanguageTextNormalization?: boolean
  apiKey: string
}

export type AudioGenerateOutput = { ok: true; audio: Uint8Array; voice: string } | { ok: false; message: string }

export type AudioVoicesOutput = { ok: true; voices: AudioVoiceOption[] } | { ok: false; message: string }

/**
 * Contract every CodeGoblin audio (text-to-speech) provider implements. Providers stay
 * stateless: the shared audio command resolves the API key, normalizes the model, writes
 * the output file, and enforces path safety, then delegates the network call here.
 */
export type AudioProvider = {
  id: string
  name: string
  defaultModel: string
  defaultOutputFormat: string
  /** Env var names checked (in order) for this provider's API key. */
  envKeys: string[]
  /** Provider id looked up in the opencode auth store as a connected-key fallback. */
  authProviderID?: string
  models: AudioProviderModel[]
  outputFormats: string[]
  /** File extension (without dot) for a given output format. */
  fileExtension: (outputFormat: string) => string
  /** Map a user-facing model alias to the provider's canonical model id. */
  normalizeModel: (model?: string) => string
  /** Resolve a default voice when the caller did not specify one. */
  resolveDefaultVoice: (request: { voice?: string; languageCode?: string }, apiKey: string) => Promise<string | undefined>
  generate: (request: AudioGenerateRequest) => Promise<AudioGenerateOutput>
  voices: (apiKey: string) => Promise<AudioVoicesOutput>
}

export function clampNumber(value: number, min: number, max: number) {
  if (Number.isNaN(value)) return min
  return Math.min(max, Math.max(min, value))
}
