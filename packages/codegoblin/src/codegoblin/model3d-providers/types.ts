export type Model3DInputMode = "text" | "image"

export type Model3DInputImage = {
  path?: string
  dataUrl?: string
  mime?: string
  filename?: string
}

export type Model3DGenerateRequest = {
  prompt: string
  model: string
  modelVersion: string
  inputMode: Model3DInputMode
  inputImages?: Model3DInputImage[]
  outputFormat: string
  apiKey: string
  onProgress?: (message: string) => void | Promise<void>
}

export type Model3DGenerateOutput =
  | { ok: true; bytes: Uint8Array; taskId: string; downloadUrl?: string }
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
  generate: (request: Model3DGenerateRequest) => Promise<Model3DGenerateOutput>
}
