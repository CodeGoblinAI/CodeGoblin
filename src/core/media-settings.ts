import fs from "node:fs/promises"
import { writeFileWhole } from "../platform/replace-file"
import path from "node:path"
import { Global } from "../platform/paths"
import type { MediaKind } from "./media"
import { PROVIDERS, kindOf } from "./providers"

/**
 * The knobs on a generator.
 *
 * Picking a model decides what a prompt becomes; these decide how it comes
 * out. They are deliberately separate from `settings.ts`, which holds the
 * handful of preferences about the app itself - a voice id is about a
 * provider, not about the terminal.
 *
 * Everything is stored as a string, because a palette deals in strings and a
 * setting nobody has touched should read the same as one set back to its
 * default. `DEFAULT` means "send nothing and let the provider decide", so an
 * untouched install behaves exactly as it did before any of this existed.
 *
 * Every value belongs to a model. The key is `provider/model:option`, so the
 * same option chosen on two models is two values. This used to be one global
 * list, which meant a voice-clone knob sat beside 3D topology whatever was
 * selected, and a choice made for one model quietly applied to another that
 * might not take it.
 */
export type MediaSettings = Record<string, string>

/** The value that means "don't send this at all". */
export const DEFAULT = "default"

/** Validate command and picker values through the same model-specific rules. */
export function requireMediaSetting(provider: string, model: string, id: string, value = DEFAULT) {
  const option = optionsForModel(provider, model).find((entry) => entry.id === id)
  if (!option) throw new Error(provider + "/" + model + " does not take setting " + id)
  if (value !== DEFAULT && !option.dynamic && !option.choices.some((choice) => choice.id === value)) {
    throw new Error(option.label + " has no " + value)
  }
  if (!value.trim()) throw new Error("Setting value cannot be empty")
  return option
}

export type MediaChoice = { id: string; label: string }

/** The model a setting is about. */
export type On = { provider: string; model: string }

export type MediaOption = {
  id: string
  kind: MediaKind
  label: string
  about: string
  /**
   * The choices, or empty when they come from the provider rather than from
   * here - a voice list belongs to an account, not to this file.
   */
  choices: MediaChoice[]
  dynamic?: "voices"
  /**
   * The providers whose request actually carries this.
   *
   * Not a claim about what a provider's API could take - a fact about the
   * request this code sends. An option lands on a model only when its provider
   * is listed here and the model is of the option's kind, which is how an image
   * model we send no options for ends up with none, rather than with a size
   * field it would silently ignore.
   */
  providers: string[]
}

const onOff = (on = "on", off = "off"): MediaChoice[] => [
  { id: DEFAULT, label: "provider default" },
  { id: "on", label: on },
  { id: "off", label: off },
]

const amounts = (label: (value: string) => string): MediaChoice[] => [
  { id: DEFAULT, label: "provider default" },
  ...["0", "0.3", "0.5", "0.75", "1"].map((value) => ({ id: value, label: label(value) })),
]

/**
 * Every setting, in one table.
 *
 * A flat list rather than a nested shape because both surfaces render it as a
 * list, and because adding a knob should be adding a row. Nothing here was
 * guessed: the audio fields are already accepted by `audio-command.ts`, and
 * the Tripo fields are the ones its own SDK puts on a task.
 */
export const MEDIA_OPTIONS: MediaOption[] = [
  {
    id: "audio.voice",
    kind: "audio",
    label: "Voice",
    about: "which voice speaks - loaded from your ElevenLabs account",
    choices: [],
    dynamic: "voices",
    providers: ["elevenlabs"],
  },
  {
    id: "audio.format",
    kind: "audio",
    label: "Audio format",
    about: "container and bitrate of the file written",
    choices: [
      { id: DEFAULT, label: "provider default" },
      { id: "mp3_44100_128", label: "MP3 44.1kHz 128kbps" },
      { id: "mp3_44100_192", label: "MP3 44.1kHz 192kbps" },
      { id: "mp3_22050_32", label: "MP3 22kHz 32kbps - small" },
      { id: "pcm_16000", label: "PCM 16kHz" },
      { id: "pcm_24000", label: "PCM 24kHz" },
      { id: "pcm_44100", label: "PCM 44.1kHz" },
      { id: "ulaw_8000", label: "u-law 8kHz - telephony" },
    ],
    providers: ["elevenlabs"],
  },
  {
    id: "audio.speed",
    kind: "audio",
    label: "Speed",
    about: "how fast it talks - the provider clamps this to 0.7 through 1.2",
    choices: [
      { id: DEFAULT, label: "provider default" },
      { id: "0.7", label: "0.7 - slow" },
      { id: "0.85", label: "0.85" },
      { id: "1", label: "1.0 - normal" },
      { id: "1.1", label: "1.1" },
      { id: "1.2", label: "1.2 - fast" },
    ],
    providers: ["elevenlabs"],
  },
  {
    id: "audio.stability",
    kind: "audio",
    label: "Stability",
    about: "lower wanders and performs, higher stays even",
    choices: amounts((value) => (value === "0" ? "0 - expressive" : value === "1" ? "1 - flat and steady" : value)),
    providers: ["elevenlabs"],
  },
  {
    id: "audio.style",
    kind: "audio",
    label: "Style",
    about: "how much of the original speaker's delivery is copied",
    choices: amounts((value) => (value === "0" ? "0 - none" : value === "1" ? "1 - strong" : value)),
    providers: ["elevenlabs"],
  },
  {
    id: "audio.boost",
    kind: "audio",
    label: "Speaker boost",
    about: "sharpens resemblance to the voice, and costs a little latency",
    choices: onOff(),
    providers: ["elevenlabs"],
  },

  {
    id: "3d.version",
    kind: "model3d",
    label: "Tripo version",
    about: "which generation of the model runs - newer is not always cheaper",
    choices: [
      { id: DEFAULT, label: "provider default" },
      { id: "P1-20260311", label: "P1" },
      { id: "v3.1-20260211", label: "H3 v3.1" },
      { id: "v3.0-20250812", label: "H3 v3.0" },
      { id: "Turbo-v1.0-20250506", label: "Turbo v1.0 - fast" },
      { id: "v2.5-20250123", label: "v2.5" },
    ],
    providers: ["tripo"],
  },
  {
    id: "3d.format",
    kind: "model3d",
    label: "Mesh format",
    about: "the file written",
    choices: [
      { id: DEFAULT, label: "provider default" },
      { id: "glb", label: "GLB - textures embedded" },
      { id: "obj", label: "OBJ - plain geometry" },
    ],
    providers: ["tripo"],
  },
  {
    id: "3d.texture",
    kind: "model3d",
    label: "Texture",
    about: "off gives untextured geometry, which is faster and cheaper",
    choices: onOff("textured", "geometry only"),
    providers: ["tripo"],
  },
  {
    id: "3d.texture-quality",
    kind: "model3d",
    label: "Texture quality",
    about: "detailed is the HD texture pass",
    choices: [
      { id: DEFAULT, label: "provider default" },
      { id: "standard", label: "standard" },
      { id: "detailed", label: "detailed - HD" },
    ],
    providers: ["tripo"],
  },
  {
    id: "3d.geometry-quality",
    kind: "model3d",
    label: "Geometry quality",
    about: "detailed keeps finer shape at a higher face count",
    choices: [
      { id: DEFAULT, label: "provider default" },
      { id: "standard", label: "standard" },
      { id: "detailed", label: "detailed - HD" },
    ],
    providers: ["tripo"],
  },
  {
    id: "3d.topology",
    kind: "model3d",
    label: "Topology",
    about: "quads are what you want if the mesh is going into a modeller",
    choices: [
      { id: DEFAULT, label: "provider default" },
      { id: "quad", label: "quads - for editing and rigging" },
      { id: "triangle", label: "triangles - for engines" },
    ],
    providers: ["tripo"],
  },
  {
    id: "3d.faces",
    kind: "model3d",
    label: "Face limit",
    about: "caps the polygon count - lower is lighter and less detailed",
    choices: [
      { id: DEFAULT, label: "no limit" },
      { id: "5000", label: "5k - low poly" },
      { id: "20000", label: "20k" },
      { id: "50000", label: "50k" },
      { id: "150000", label: "150k - dense" },
    ],
    providers: ["tripo"],
  },

  {
    id: "image.size",
    kind: "image",
    label: "Image size",
    about: "the resolution of the image written",
    choices: [
      { id: DEFAULT, label: "2K - what we send today" },
      { id: "1K", label: "1K" },
      { id: "2K", label: "2K" },
      { id: "4K", label: "4K" },
    ],
    // xAI, OpenAI and Gemini do not take a size on the request we send, so
    // showing them this would be offering a knob attached to nothing.
    providers: ["qwen"],
  },
]

export function optionById(id: string): MediaOption | undefined {
  return MEDIA_OPTIONS.find((option) => option.id === id)
}

export function optionsOfKind(kind: MediaKind): MediaOption[] {
  return MEDIA_OPTIONS.filter((option) => option.kind === kind)
}

/**
 * The settings a model takes, in table order.
 *
 * A model the catalogue does not have takes nothing, which is also what keeps
 * a stale key on disk - for a model since removed from the catalogue - from
 * reaching any request.
 */
export function optionsForModel(provider: string, model: string): MediaOption[] {
  const found = PROVIDERS[provider]?.models.find((each) => each.id === model)
  if (!found) return []
  const kind = kindOf(found)
  return MEDIA_OPTIONS.filter((option) => option.kind === kind && option.providers.includes(provider))
}

const takes = (on: On, id: string) => optionsForModel(on.provider, on.model).some((option) => option.id === id)

/** Where a value lives: `provider/model:option`. */
const keyOf = (on: On, id: string) => on.provider + "/" + on.model + ":" + id

/** A stored key taken apart again, or nothing when it is not one of ours. */
function parseKey(key: string): (On & { id: string }) | undefined {
  const colon = key.lastIndexOf(":")
  const slash = key.indexOf("/")
  // No colon is one of the old global keys; a slash after the colon is not a
  // provider/model at all. Neither describes a model's setting.
  if (colon <= 0 || slash <= 0 || slash > colon) return undefined
  const provider = key.slice(0, slash)
  const model = key.slice(slash + 1, colon)
  const id = key.slice(colon + 1)
  return provider && model && id ? { provider, model, id } : undefined
}

/** What this model holds for a setting, falling back to the sentinel rather than to nothing. */
export function valueOf(settings: MediaSettings, provider: string, model: string, id: string): string {
  const value = settings[keyOf({ provider, model }, id)]
  return typeof value === "string" && value ? value : DEFAULT
}

/**
 * The label for a value, so a list can say "detailed - HD" rather than
 * "detailed". A voice id has no entry here, so it is shown as it came.
 */
export function labelOf(option: MediaOption, value: string, voices: MediaChoice[] = []): string {
  const pool = option.dynamic === "voices" ? [{ id: DEFAULT, label: "account default" }, ...voices] : option.choices
  return pool.find((choice) => choice.id === value)?.label ?? value
}

/**
 * Drop a value in for one model, or take it out.
 *
 * Setting something back to its default removes the key rather than storing
 * the word "default", so the file only ever holds decisions somebody made.
 */
export function withValue(
  settings: MediaSettings,
  provider: string,
  model: string,
  id: string,
  value: string,
): MediaSettings {
  const next = { ...settings }
  const key = keyOf({ provider, model }, id)
  if (value === DEFAULT) delete next[key]
  else next[key] = value
  return next
}

/**
 * Only a real setting, on a model that takes it, survives a reload.
 *
 * The old global keys - "3d.topology" with no model attached - are dropped
 * rather than carried forward. They described a setting that applied to every
 * model, which is precisely the thing that turned out to be wrong, and guessing
 * which model each was meant for would be inventing a decision nobody made.
 */
export function normaliseMedia(raw: unknown): MediaSettings {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {}
  const out: MediaSettings = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== "string" || !value || value === DEFAULT) continue
    const parts = parseKey(key)
    if (!parts || !takes(parts, parts.id)) continue
    out[key] = value
  }
  return out
}

/**
 * A setting as a number, or nothing.
 *
 * The empty-string guard is load-bearing: Number("") is 0, and 0 is finite, so
 * an unset value read straight through Number() arrives as a real, deliberate
 * zero. That is how "nothing chosen" became "stability: 0" and sent a setting
 * to a provider nobody asked for.
 */
const number = (value: string | undefined): number | undefined => {
  if (value === undefined || value.trim() === "") return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

/**
 * A value that can reach this model's request, or nothing.
 *
 * Checked against what the model takes as well as what is stored, so a key on
 * disk can never carry a setting to a model it was not chosen for.
 */
const set = (settings: MediaSettings, on: On, id: string): string | undefined => {
  if (!takes(on, id)) return undefined
  const value = settings[keyOf(on, id)]
  return value && value !== DEFAULT ? value : undefined
}

export type AudioOverrides = {
  voice?: string
  outputFormat?: string
  voiceSettings?: {
    stability?: number
    style?: number
    speed?: number
    useSpeakerBoost?: boolean
  }
}

export function audioOverrides(settings: MediaSettings, on: On): AudioOverrides {
  const stability = set(settings, on, "audio.stability")
  const style = set(settings, on, "audio.style")
  const speed = set(settings, on, "audio.speed")
  const boost = set(settings, on, "audio.boost")

  const asNumber = (value: string | undefined, key: string) => {
    const parsed = number(value)
    return parsed === undefined ? {} : { [key]: parsed }
  }

  const voiceSettings = {
    ...asNumber(stability, "stability"),
    ...asNumber(style, "style"),
    ...asNumber(speed, "speed"),
    ...(boost !== undefined ? { useSpeakerBoost: boost === "on" } : {}),
  }

  const voice = set(settings, on, "audio.voice")
  const outputFormat = set(settings, on, "audio.format")

  return {
    ...(voice !== undefined ? { voice } : {}),
    ...(outputFormat !== undefined ? { outputFormat } : {}),
    // An empty object would still be sent as voice_settings, which overrides
    // whatever the voice was saved with. Nothing chosen means nothing sent.
    ...(Object.keys(voiceSettings).length ? { voiceSettings } : {}),
  }
}

type Quality = "standard" | "detailed"
const quality = (value: string | undefined): Quality | undefined =>
  value === "standard" || value === "detailed" ? value : undefined

export type Model3DShapeOverrides = {
  texture?: boolean
  textureQuality?: Quality
  geometryQuality?: Quality
  quad?: boolean
  faceLimit?: number
}

export type Model3DOverrides = Model3DShapeOverrides & {
  modelVersion?: string
  outputFormat?: string
}

/**
 * Every key here is present only when it was chosen.
 *
 * That matters more than it looks: the caller decides whether to send a shape
 * at all by counting keys, and a key holding undefined counts. Written the
 * obvious way, an untouched install would have sent Tripo a shape object full
 * of nothing and stopped being untouched.
 */
export function model3dOverrides(settings: MediaSettings, on: On): Model3DOverrides {
  const version = set(settings, on, "3d.version")
  const format = set(settings, on, "3d.format")
  const texture = set(settings, on, "3d.texture")
  const textureQuality = quality(set(settings, on, "3d.texture-quality"))
  const geometryQuality = quality(set(settings, on, "3d.geometry-quality"))
  const topology = set(settings, on, "3d.topology")
  const faces = number(set(settings, on, "3d.faces"))
  return {
    ...(version !== undefined ? { modelVersion: version } : {}),
    ...(format !== undefined ? { outputFormat: format } : {}),
    ...(texture !== undefined ? { texture: texture === "on" } : {}),
    ...(textureQuality !== undefined ? { textureQuality } : {}),
    ...(geometryQuality !== undefined ? { geometryQuality } : {}),
    ...(topology !== undefined ? { quad: topology === "quad" } : {}),
    ...(faces !== undefined ? { faceLimit: faces } : {}),
  }
}

export type ImageOverrides = { size?: string }

export function imageOverrides(settings: MediaSettings, on: On): ImageOverrides {
  return { size: set(settings, on, "image.size") }
}

/**
 * Where they live.
 *
 * A file of its own rather than a corner of settings.json: these belong to
 * providers and will keep growing as providers gain knobs, and settings.json
 * is meant to stay small enough to read at a glance.
 */
const file = path.join(Global.Path.state, "media.json")

export async function loadMedia(): Promise<MediaSettings> {
  try {
    return normaliseMedia(JSON.parse(await fs.readFile(file, "utf8")))
  } catch {
    return {}
  }
}

export async function saveMedia(settings: MediaSettings): Promise<void> {
  try {
    await fs.mkdir(path.dirname(file), { recursive: true })
    await writeFileWhole(file, JSON.stringify(settings, null, 2))
  } catch {
    // A preference that cannot be written is not worth interrupting anyone.
  }
}
