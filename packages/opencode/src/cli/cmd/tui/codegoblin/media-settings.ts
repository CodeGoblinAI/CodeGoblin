// KV-backed defaults for CodeGoblin /image and /audio generation. These keys
// live in the TUI KV store (Global.Path.state/kv.json) so the user's preferred
// output directory, voice, and format persist across sessions.

export const MediaSettingsKeys = {
  imageOutputDir: "codegoblin_image_output_dir",
  imageAutoApprove: "codegoblin_image_auto_approve",
  audioVoice: "codegoblin_audio_voice",
  audioFormat: "codegoblin_audio_format",
  audioAutoApprove: "codegoblin_audio_auto_approve",
} as const

export const MediaSettingsDefaults = {
  imageOutputDir: "codegoblin-output/images",
  imageAutoApprove: false,
  audioVoice: "",
  audioFormat: "mp3_44100_128",
  audioAutoApprove: false,
} as const

// Common ElevenLabs output formats the user can cycle through.
export const AudioFormatOptions = [
  "mp3_44100_128",
  "mp3_44100_192",
  "mp3_22050_32",
  "pcm_16000",
  "pcm_24000",
  "pcm_44100",
  "ulaw_8000",
] as const

type KVLike = {
  get: (key: string, defaultValue?: any) => any
  set: (key: string, value: any) => void
}

export type ImageMediaSettings = {
  outputDir: string
  autoApprove: boolean
}

export type AudioMediaSettings = {
  voice: string
  format: string
  autoApprove: boolean
}

export function readImageSettings(kv: KVLike): ImageMediaSettings {
  return {
    outputDir: kv.get(MediaSettingsKeys.imageOutputDir, MediaSettingsDefaults.imageOutputDir),
    autoApprove: kv.get(MediaSettingsKeys.imageAutoApprove, MediaSettingsDefaults.imageAutoApprove),
  }
}

export function readAudioSettings(kv: KVLike): AudioMediaSettings {
  return {
    voice: kv.get(MediaSettingsKeys.audioVoice, MediaSettingsDefaults.audioVoice),
    format: kv.get(MediaSettingsKeys.audioFormat, MediaSettingsDefaults.audioFormat),
    autoApprove: kv.get(MediaSettingsKeys.audioAutoApprove, MediaSettingsDefaults.audioAutoApprove),
  }
}
