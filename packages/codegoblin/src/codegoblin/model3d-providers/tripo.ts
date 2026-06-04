import fs from "fs/promises"
import path from "path"
import type { Model3DGenerateRequest, Model3DGenerateOutput, Model3DInputImage, Model3DProvider } from "./types"

const API_BASE = "https://api.tripo3d.ai/v2/openapi"
const DEFAULT_MODEL_VERSION = "v3.1-20260211"

const MODEL_VERSIONS = [
  { id: "v3.1-20260211", name: "Tripo H3 v3.1" },
  { id: "v3.0-20250812", name: "Tripo H3 v3.0" },
] as const

/** Tripo bills in credits; these are observed defaults for H3 v3.0/v3.1. */
const TRIPO_CREDIT_ESTIMATES: Record<string, { text: number; image: number }> = {
  "v3.1-20260211": { text: 20, image: 30 },
  "v3.0-20250812": { text: 20, image: 30 },
}

export function estimateTripoCredits(inputMode: "text" | "image", modelVersion: string) {
  const table = TRIPO_CREDIT_ESTIMATES[modelVersion] ?? { text: 20, image: 30 }
  return inputMode === "image" ? table.image : table.text
}

type TripoTaskResponse = {
  code?: number
  data?: {
    task_id?: string
    status?: string
    output?: {
      model?: string
      pbr_model?: string
      base_model?: string
    }
  }
  message?: string
}

type TripoUploadResponse = {
  code?: number
  data?: {
    image_token?: string
    file_token?: string
    object?: { bucket?: string; key?: string }
  }
  message?: string
}

async function tripoFetch<T>(apiKey: string, route: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${route}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      ...(init?.headers ?? {}),
    },
  })
  const text = await response.text()
  let json: T & { message?: string }
  try {
    json = JSON.parse(text) as T & { message?: string }
  } catch {
    throw new Error(`Tripo API returned non-JSON (${response.status}): ${text.slice(0, 200)}`)
  }
  if (!response.ok) {
    throw new Error(json.message ?? `Tripo API error (${response.status})`)
  }
  return json
}

function imageFormat(image: Model3DInputImage, bytes: Uint8Array): "png" | "jpeg" | "webp" {
  const mime = image.mime ?? image.dataUrl?.match(/^data:([^;,]+)/)?.[1] ?? ""
  if (mime.includes("jpeg") || mime.includes("jpg")) return "jpeg"
  if (mime.includes("webp")) return "webp"
  const ext = image.path ? path.extname(image.path).toLowerCase() : ""
  if (ext === ".jpg" || ext === ".jpeg") return "jpeg"
  if (ext === ".webp") return "webp"
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "jpeg"
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return "png"
  return "png"
}

async function readImageBytes(image: Model3DInputImage, root?: string): Promise<{ bytes: Uint8Array; filename: string }> {
  if (image.dataUrl) {
    const match = /^data:[^;]+;base64,(.+)$/.exec(image.dataUrl)
    if (!match) throw new Error("Invalid image data URL.")
    return {
      bytes: Uint8Array.from(Buffer.from(match[1], "base64")),
      filename: image.filename ?? "input.png",
    }
  }
  if (!image.path) throw new Error("Image input requires a path or data URL.")
  const absolute = root ? path.resolve(root, image.path) : path.resolve(image.path)
  const bytes = await fs.readFile(absolute)
  return { bytes: new Uint8Array(bytes), filename: image.filename ?? path.basename(absolute) }
}

async function uploadImage(apiKey: string, image: Model3DInputImage, root?: string) {
  const { bytes, filename } = await readImageBytes(image, root)
  const form = new FormData()
  const blob = new Blob([bytes], { type: image.mime ?? "image/png" })
  form.append("file", blob, filename)

  const response = await fetch(`${API_BASE}/upload/sts`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  })
  const json = (await response.json()) as TripoUploadResponse
  if (!response.ok) {
    throw new Error(json.message ?? `Tripo image upload failed (${response.status})`)
  }

  if (json.data?.object?.bucket && json.data.object.key) {
    return { bucket: json.data.object.bucket, key: json.data.object.key }
  }
  if (json.data?.file_token) {
    return { file_token: json.data.file_token }
  }
  if (json.data?.image_token) {
    return { file_token: json.data.image_token }
  }
  throw new Error("Tripo upload did not return file credentials.")
}

async function createTask(apiKey: string, body: Record<string, unknown>) {
  const json = await tripoFetch<TripoTaskResponse>(apiKey, "/task", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  const taskId = json.data?.task_id
  if (!taskId) throw new Error(json.message ?? "Tripo did not return a task id.")
  return taskId
}

async function pollTask(apiKey: string, taskId: string, onProgress?: (message: string) => void | Promise<void>) {
  for (let attempt = 0; attempt < 120; attempt++) {
    const json = await tripoFetch<TripoTaskResponse>(apiKey, `/task/${taskId}`)
    const status = json.data?.status ?? "unknown"
    await onProgress?.(`Tripo task ${taskId}: ${status}`)
    if (status === "success") return json.data
    if (status === "failed" || status === "cancelled" || status === "banned") {
      throw new Error(json.message ?? `Tripo task ${status}.`)
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(3000 + attempt * 250, 8000)))
  }
  throw new Error("Tripo task timed out while waiting for the 3D model.")
}

async function downloadModel(url: string) {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`Tripo model download failed (${response.status}).`)
  return new Uint8Array(await response.arrayBuffer())
}

async function generateTripo(request: Model3DGenerateRequest): Promise<Model3DGenerateOutput> {
  const modelVersion = request.modelVersion || DEFAULT_MODEL_VERSION
  let taskId: string

  try {
    if (request.inputMode === "image") {
      const image = request.inputImages?.[0]
      if (!image) return { ok: false, message: "Image-to-3D requires an attached image." }
      await request.onProgress?.("Uploading image to Tripo…")
      const uploaded = await uploadImage(request.apiKey, image)
      const filePayload =
        "bucket" in uploaded && uploaded.bucket && uploaded.key
          ? { object: { bucket: uploaded.bucket, key: uploaded.key } }
          : { file_token: (uploaded as { file_token: string }).file_token }

      taskId = await createTask(request.apiKey, {
        type: "image_to_model",
        model_version: modelVersion,
        file: filePayload,
      })
    } else {
      if (!request.prompt.trim()) return { ok: false, message: "Text-to-3D requires a prompt." }
      taskId = await createTask(request.apiKey, {
        type: "text_to_model",
        prompt: request.prompt.trim(),
        model_version: modelVersion,
      })
    }

    await request.onProgress?.(`Tripo task started (${taskId}). Generating 3D model…`)
    const result = await pollTask(request.apiKey, taskId, request.onProgress)
    const downloadUrl = result?.output?.model ?? result?.output?.pbr_model ?? result?.output?.base_model
    if (!downloadUrl) return { ok: false, message: "Tripo finished without a model download URL.", taskId }

    await request.onProgress?.("Downloading 3D model…")
    const bytes = await downloadModel(downloadUrl)
    const credits = estimateTripoCredits(request.inputMode, modelVersion)
    return { ok: true, bytes, taskId, downloadUrl, credits }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "Tripo 3D generation failed.", taskId }
  }
}

export const tripoProvider: Model3DProvider = {
  id: "tripo",
  name: "Tripo 3D",
  defaultModel: "text-to-model",
  defaultModelVersion: DEFAULT_MODEL_VERSION,
  modelVersions: [...MODEL_VERSIONS],
  outputFormats: ["glb", "obj"],
  envKeys: ["TRIPO_API_KEY", "CODEGOBLIN_TRIPO_API_KEY"],
  authProviderID: "tripo",
  models: [
    { id: "text-to-model", name: "Tripo Text to 3D", inputMode: "text" },
    { id: "image-to-model", name: "Tripo Image to 3D", inputMode: "image" },
  ],
  normalizeModel(model?: string) {
    const value = model?.trim().toLowerCase() ?? ""
    if (value.includes("image")) return "image-to-model"
    return "text-to-model"
  },
  normalizeModelVersion(variant?: string) {
    const value = variant?.trim()
    if (value && MODEL_VERSIONS.some((item) => item.id === value)) return value
    return DEFAULT_MODEL_VERSION
  },
  fileExtension(outputFormat: string) {
    return outputFormat === "obj" ? "obj" : "glb"
  },
  estimateCredits: estimateTripoCredits,
  generate: generateTripo,
}
