export const MODEL_BUCKET_ORDER = ["Text models", "Local models", "Image models", "3D models", "Voice & audio models", "Other models"] as const

const SECTION_ORDER = ["Favorites", "Recent"] as const

type ModelCapabilities = {
  input?: {
    text?: boolean
    audio?: boolean
    image?: boolean
  }
  output?: {
    text?: boolean
    audio?: boolean
    image?: boolean
    model3d?: boolean
  }
}

export type BucketModelInfo = {
  family?: string
  name?: string
  capabilities?: ModelCapabilities
}

export function is3DOnlyModel(info: BucketModelInfo) {
  const output = info.capabilities?.output
  return output?.model3d === true && output.text !== true && output.image !== true && output.audio !== true
}

export function isAudioOnlyModel(info: BucketModelInfo) {
  return info.capabilities?.output?.audio === true && info.capabilities.output.text !== true && info.capabilities.output.image !== true && !is3DOnlyModel(info)
}

export function isChatSelectableModel(info: BucketModelInfo) {
  if (is3DOnlyModel(info) || isAudioOnlyModel(info)) return true
  return info.capabilities?.output?.audio === true || info.capabilities?.output?.image === true || info.capabilities?.output?.text === true || info.capabilities?.input?.text === true
}

export function isDefaultChatModel(info: BucketModelInfo) {
  const output = info.capabilities?.output
  // No capability data — assume a plain chat model (the server defaults output.text to true).
  if (!output) return true
  // The chat composer must never default to a generation-only model: anything that
  // declares outputs but not text (video/image/audio/3D-only) is not a chat default.
  return output.text === true
}

export function modelBucket(modelID: string, info: BucketModelInfo) {
  if (info.family === "local") return "Local models"
  if (info.capabilities?.output?.model3d || is3DGenerationModel(modelID, info)) return "3D models"
  if (info.capabilities?.output?.audio || isAudioGenerationModel(modelID, info)) return "Voice & audio models"
  if (info.capabilities?.output?.image || isImageGenerationModel(modelID, info)) return "Image models"
  if (info.capabilities?.output?.text || info.capabilities?.input?.text) return "Text models"
  return "Other models"
}

export function modelCategory(providerName: string, modelID: string, info: BucketModelInfo) {
  return `${modelBucket(modelID, info)} · ${providerName}`
}

export function sortModelCategories(a: string, b: string) {
  const left = categoryParts(a)
  const right = categoryParts(b)
  return (
    left.section - right.section ||
    left.bucket - right.bucket ||
    left.provider.localeCompare(right.provider) ||
    a.localeCompare(b)
  )
}

function categoryParts(category: string) {
  const [first = "", second = ""] = category.split(" · ")
  const sectionIndex = SECTION_ORDER.indexOf(first as (typeof SECTION_ORDER)[number])
  if (sectionIndex >= 0) {
    return {
      section: sectionIndex,
      bucket: bucketIndex(second),
      provider: "",
    }
  }

  return {
    section: SECTION_ORDER.length,
    bucket: bucketIndex(first),
    provider: second,
  }
}

function bucketIndex(bucket: string) {
  const index = MODEL_BUCKET_ORDER.indexOf(bucket as (typeof MODEL_BUCKET_ORDER)[number])
  return index >= 0 ? index : MODEL_BUCKET_ORDER.length
}

function is3DGenerationModel(modelID: string, info: BucketModelInfo) {
  const raw = `${modelID} ${info.family ?? ""}`.toLowerCase()
  return /(^|[\s/_-])(tripo|text-to-model|image-to-model|3d-model)([\s/_-]|$)/.test(raw)
}

function isImageGenerationModel(modelID: string, info: BucketModelInfo) {
  const raw = `${modelID} ${info.family ?? ""}`.toLowerCase()
  return /(^|[\s/_-])(gpt-image|chatgpt-image|dall-e|dalle|imagen|qwen-image|grok-imagine|flash-image|nano-banana|nanobanana)([\s/_-]|$)/.test(raw) || /(^|[\s/_-])wan\d+(?:[.-]\d+)?-image/.test(raw)
}

function isAudioGenerationModel(modelID: string, info: BucketModelInfo) {
  const raw = `${modelID} ${info.family ?? ""}`.toLowerCase()
  return /(^|[\s/_-])(tts|text-to-speech|voice|music|elevenlabs)([\s/_-]|$)/.test(raw)
}
