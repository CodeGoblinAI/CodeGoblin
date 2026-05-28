export const MODEL_BUCKET_ORDER = ["Text models", "Image models", "Voice & audio models", "Other models"] as const

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
  }
}

export type BucketModel = {
  id: string
  name?: string
  family?: string
  capabilities?: ModelCapabilities
}

export function isAudioOnlyModel(model: BucketModel) {
  return model.capabilities?.output?.audio === true && model.capabilities.output.text !== true && model.capabilities.output.image !== true
}

export function isChatSelectableModel(model: BucketModel) {
  return !isAudioOnlyModel(model)
}

export function modelBucket(model: BucketModel) {
  if (model.capabilities?.output?.audio || isAudioGenerationModel(model)) return "Voice & audio models"
  if (model.capabilities?.output?.image || isImageGenerationModel(model)) return "Image models"
  if (model.capabilities?.output?.text || model.capabilities?.input?.text) return "Text models"
  return "Other models"
}

function isImageGenerationModel(model: BucketModel) {
  const raw = `${model.id} ${model.family ?? ""}`.toLowerCase()
  return /(^|[\s/_-])(gpt-image|chatgpt-image|dall-e|dalle|imagen|qwen-image|grok-imagine|flash-image|nano-banana|nanobanana)([\s/_-]|$)/.test(raw) || /(^|[\s/_-])wan\d+(?:[.-]\d+)?-image/.test(raw)
}

function isAudioGenerationModel(model: BucketModel) {
  const raw = `${model.id} ${model.family ?? ""}`.toLowerCase()
  return /(^|[\s/_-])(tts|text-to-speech|voice|music|elevenlabs)([\s/_-]|$)/.test(raw)
}