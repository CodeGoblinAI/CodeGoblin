export type Model3DInputMode = "text" | "image"

export type Model3DInputImage = {
  path?: string
  dataUrl?: string
  mime?: string
  filename?: string
}

/**
 * How the mesh should come out.
 *
 * Every field here is one Tripo's own SDK puts on a task, under the same
 * name - it copies its arguments straight onto the request body. Undefined
 * means the field is left off entirely, which is what keeps an untouched
 * install generating exactly what it generated before.
 */
export type Model3DShape = {
  /** false asks for untextured geometry, which is faster and cheaper. */
  texture?: boolean
  textureQuality?: "standard" | "detailed"
  geometryQuality?: "standard" | "detailed"
  /** true asks for a quad mesh rather than triangles. */
  quad?: boolean
  faceLimit?: number
}

export type Model3DGenerateRequest = {
  prompt: string
  model: string
  modelVersion: string
  shape?: Model3DShape
  inputMode: Model3DInputMode
  inputImages?: Model3DInputImage[]
  outputFormat: string
  apiKey: string
  cwd?: string
  onProgress?: (message: string) => void | Promise<void>
}

export type Model3DGenerateOutput =
  | { ok: true; bytes: Uint8Array; taskId: string; downloadUrl?: string; credits?: number }
  | { ok: false; message: string; taskId?: string }

export type Model3DProviderModel = {
  id: string
  name: string
  inputMode: Model3DInputMode
}

export type Model3DProvider = {
  id: string
  name: string
  defaultModel: string
  defaultModelVersion: string
  modelVersions: { id: string; name: string }[]
  outputFormats: string[]
  envKeys: string[]
  authProviderID?: string
  models: Model3DProviderModel[]
  normalizeModel: (model?: string) => string
  normalizeModelVersion: (variant?: string) => string
  fileExtension: (outputFormat: string) => string
  estimateCredits?: (inputMode: Model3DInputMode, modelVersion: string) => number
  generate: (request: Model3DGenerateRequest) => Promise<Model3DGenerateOutput>
}
