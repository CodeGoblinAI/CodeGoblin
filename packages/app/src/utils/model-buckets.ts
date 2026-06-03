export const MODEL_BUCKET_ORDER = ["Text models", "Image models", "3D models", "Voice & audio models", "Other models"] as const

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

export type BucketModel = {
  id: string
  name?: string
  family?: string
  capabilities?: ModelCapabilities
}

export function is3DOnlyModel(model: BucketModel) {
  const output = model.capabilities?.output
  return output?.model3d === true && output.text !== true && output.image !== true && output.audio !== true
}

export function isAudioOnlyModel(model: BucketModel) {
  return model.capabilities?.output?.audio === true && model.capabilities.output.text !== true && model.capabilities.output.image !== true && !is3DOnlyModel(model)
}

export function isChatSelectableModel(model: BucketModel) {
  if (is3DOnlyModel(model) || isAudioOnlyModel(model)) return true
  return model.capabilities?.output?.audio === true || model.capabilities?.output?.image === true || model.capabilities?.output?.text === true || model.capabilities?.input?.text === true
}

export function isDefaultChatModel(model: BucketModel) {
  return !isAudioOnlyModel(model) && !is3DOnlyModel(model)
}

export function modelBucket(model: BucketModel) {
  if (model.capabilities?.output?.model3d || is3DGenerationModel(model)) return "3D models"
  if (model.capabilities?.output?.audio || isAudioGenerationModel(model)) return "Voice & audio models"
  if (model.capabilities?.output?.image || isImageGenerationModel(model)) return "Image models"
  if (model.capabilities?.output?.text || model.capabilities?.input?.text) return "Text models"
  return "Other models"
}

function is3DGenerationModel(model: BucketModel) {
  const raw = `${model.id} ${model.family ?? ""}`.toLowerCase()
  return /(^|[\s/_-])(tripo|text-to-model|image-to-model|3d-model)([\s/_-]|$)/.test(raw)
}

function isImageGenerationModel(model: BucketModel) {
  const raw = `${model.id} ${model.family ?? ""}`.toLowerCase()
  return /(^|[\s/_-])(gpt-image|chatgpt-image|dall-e|dalle|imagen|qwen-image|grok-imagine|flash-image|nano-banana|nanobanana)([\s/_-]|$)/.test(raw) || /(^|[\s/_-])wan\d+(?:[.-]\d+)?-image/.test(raw)
}

function isAudioGenerationModel(model: BucketModel) {
  const raw = `${model.id} ${model.family ?? ""}`.toLowerCase()
  return /(^|[\s/_-])(tts|text-to-speech|voice|music|elevenlabs)([\s/_-]|$)/.test(raw)
}
