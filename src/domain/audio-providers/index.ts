import { ElevenLabsAudioProvider } from "./elevenlabs"
import { GoogleAudioProvider } from "./google"
import type { AudioProvider } from "./types"

export * from "./types"

export const DEFAULT_AUDIO_PROVIDER = "elevenlabs"

const REGISTRY: Record<string, AudioProvider> = {
  [ElevenLabsAudioProvider.id]: ElevenLabsAudioProvider,
  [GoogleAudioProvider.id]: GoogleAudioProvider,
}

export function listAudioProviders(): AudioProvider[] {
  return Object.values(REGISTRY)
}

export function getAudioProvider(id?: string): AudioProvider {
  const key = id?.trim().toLowerCase()
  if (key && REGISTRY[key]) return REGISTRY[key]
  return REGISTRY[DEFAULT_AUDIO_PROVIDER]
}

export function isKnownAudioProvider(id?: string): boolean {
  const key = id?.trim().toLowerCase()
  return Boolean(key && REGISTRY[key])
}
