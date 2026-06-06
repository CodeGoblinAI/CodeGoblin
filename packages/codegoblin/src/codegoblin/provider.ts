import { ModelID, ProviderID } from "@/provider/schema"
import type { Info, Model } from "@/provider/provider"
import { listInstalledModels } from "./local-runtime"

export const CodeGoblinProvider = {
  id: ProviderID.make("codegoblin"),
  name: "CodeGoblin",
  env: ["CODEGOBLIN_API_KEY", "CODEGOBLIN_GATEWAY_KEY"],
  baseURL: "http://127.0.0.1:8787/v1",
  models: {
    "deepseek-chat": {
      id: ModelID.make("deepseek-chat"),
      apiID: "deepseek-chat",
      name: "CodeGoblin DeepSeek Chat",
      family: "deepseek",
      context: 64_000,
      output: 8_000,
      inputModalities: ["text"],
      outputModalities: ["text"],
    },
    "goblin-mock": {
      id: ModelID.make("goblin-mock"),
      apiID: "goblin-mock",
      name: "CodeGoblin Mock Model",
      family: "mock",
      context: 8_000,
      output: 2_000,
      inputModalities: ["text"],
      outputModalities: ["text"],
    },
    "goblin-image-mock": {
      id: ModelID.make("goblin-image-mock"),
      apiID: "goblin-image-mock",
      name: "CodeGoblin Image Mock",
      family: "image",
      context: 8_000,
      output: 1_000,
      inputModalities: ["text", "image"],
      outputModalities: ["image"],
    },
    "qwen-image-pro": {
      id: ModelID.make("qwen-image-pro"),
      apiID: "wan2.7-image-pro",
      name: "Qwen Image Pro",
      family: "qwen-image",
      context: 8_000,
      output: 1_000,
      inputModalities: ["text"],
      outputModalities: ["image"],
    },
    "qwen-image-edit": {
      id: ModelID.make("qwen-image-edit"),
      apiID: "wan2.7-image-edit",
      name: "Qwen Image Edit",
      family: "qwen-image",
      context: 8_000,
      output: 1_000,
      inputModalities: ["text", "image"],
      outputModalities: ["image"],
    },
    "elevenlabs-tts": {
      id: ModelID.make("elevenlabs-tts"),
      apiID: "eleven_multilingual_v2",
      name: "ElevenLabs Text to Speech",
      family: "elevenlabs",
      context: 5_000,
      output: 0,
      inputModalities: ["text"],
      outputModalities: ["audio"],
    },
    "elevenlabs-music": {
      id: ModelID.make("elevenlabs-music"),
      apiID: "elevenlabs-music",
      name: "ElevenLabs Music",
      family: "elevenlabs",
      context: 2_000,
      output: 0,
      inputModalities: ["text"],
      outputModalities: ["audio"],
    },
  },
} as const

export const ElevenLabsProvider = {
  id: ProviderID.make("elevenlabs"),
  name: "ElevenLabs",
  env: ["ELEVENLABS_API_KEY", "CODEGOBLIN_ELEVENLABS_API_KEY"],
  baseURL: "https://api.elevenlabs.io/v1",
} as const

function model(id: keyof typeof CodeGoblinProvider.models): Model {
  const item = CodeGoblinProvider.models[id]
  return {
    id: item.id,
    providerID: CodeGoblinProvider.id,
    name: item.name,
    family: item.family,
    api: {
      id: item.apiID,
      npm: "@ai-sdk/openai-compatible",
      url: CodeGoblinProvider.baseURL,
    },
    status: "active",
    headers: {},
    options: {},
    capabilities: {
      temperature: true,
      reasoning: id === "deepseek-chat",
      attachment: false,
      toolcall: true,
      input: {
        text: (item.inputModalities as readonly string[]).includes("text"),
        audio: (item.inputModalities as readonly string[]).includes("audio"),
        image: (item.inputModalities as readonly string[]).includes("image"),
        video: false,
        pdf: false,
      },
      output: {
        text: (item.outputModalities as readonly string[]).includes("text"),
        audio: (item.outputModalities as readonly string[]).includes("audio"),
        image: (item.outputModalities as readonly string[]).includes("image"),
        video: false,
        pdf: false,
      },
      interleaved: id === "deepseek-chat" ? { field: "reasoning_content" } : false,
    },
    cost: {
      input: 0,
      output: 0,
      cache: {
        read: 0,
        write: 0,
      },
    },
    limit: {
      context: item.context,
      output: item.output,
    },
    release_date: "",
    variants: {},
  }
}

export function codeGoblinProviderInfo(): Info {
  return {
    id: CodeGoblinProvider.id,
    name: CodeGoblinProvider.name,
    source: "custom",
    env: [...CodeGoblinProvider.env],
    options: {
      baseURL: process.env.CODEGOBLIN_GATEWAY_URL || CodeGoblinProvider.baseURL,
      name: "codegoblin",
    },
    models: {
      "deepseek-chat": model("deepseek-chat"),
      "goblin-mock": model("goblin-mock"),
      "goblin-image-mock": model("goblin-image-mock"),
      "qwen-image-pro": model("qwen-image-pro"),
      "qwen-image-edit": model("qwen-image-edit"),
      "elevenlabs-tts": model("elevenlabs-tts"),
      "elevenlabs-music": model("elevenlabs-music"),
    },
  }
}

function localRuntimeModel(id: string, baseURL: string, context: number): Model {
  return {
    id: ModelID.make(id),
    providerID: CodeGoblinProvider.id,
    name: id,
    family: "local",
    api: { id, npm: "@ai-sdk/openai-compatible", url: baseURL },
    status: "active",
    headers: {},
    options: {},
    capabilities: {
      temperature: true,
      reasoning: false,
      attachment: false,
      toolcall: true,
      input: { text: true, audio: false, image: false, video: false, pdf: false },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: false,
    },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context, output: Math.min(context, 4096) },
    release_date: "",
    variants: {},
  }
}

/**
 * Surface installed local GGUF models (served by `codegoblin runtime start` on :8787)
 * as `codegoblin/<id>` entries so they appear in the model picker. Best-effort: never
 * throws, no-ops when nothing is installed.
 */
export async function augmentLocalRuntimeModels(
  catalog: Record<string, Info>,
  database: Record<string, Info>,
): Promise<void> {
  let installed: Awaited<ReturnType<typeof listInstalledModels>>
  try {
    installed = await listInstalledModels()
  } catch {
    return
  }
  if (installed.length === 0) return
  const baseURL = process.env.CODEGOBLIN_GATEWAY_URL || CodeGoblinProvider.baseURL
  for (const target of [catalog[CodeGoblinProvider.id], database[CodeGoblinProvider.id]]) {
    if (!target) continue
    for (const item of installed) {
      target.models[item.id] = localRuntimeModel(item.id, baseURL, 32768)
    }
  }
}

export function elevenLabsProviderInfo(): Info {
  return {
    id: ElevenLabsProvider.id,
    name: ElevenLabsProvider.name,
    source: "custom",
    env: [...ElevenLabsProvider.env],
    options: {
      baseURL: ElevenLabsProvider.baseURL,
      name: "elevenlabs",
    },
    models: {},
  }
}

export function augmentImageModelCatalog(catalog: Record<string, Info>) {
  addImageModel(catalog, "openai", "gpt-image-1", {
    name: "GPT Image 1",
    family: "gpt-image",
    apiURL: "https://api.openai.com/v1",
    npm: "@ai-sdk/openai",
    inputImage: true,
    cost: 0.042,
  })
  addImageModel(catalog, "openai", "gpt-image-1-mini", {
    name: "GPT Image 1 Mini",
    family: "gpt-image",
    apiURL: "https://api.openai.com/v1",
    npm: "@ai-sdk/openai",
    inputImage: true,
    cost: 0.011,
  })
  addImageModel(catalog, "alibaba", "wan2.7-image-pro", {
    name: "Qwen Image Pro",
    family: "qwen-image",
    apiURL: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    npm: "@ai-sdk/openai-compatible",
    inputImage: false,
    cost: 0,
  })
  addImageModel(catalog, "alibaba", "wan2.7-image-edit", {
    name: "Qwen Image Edit",
    family: "qwen-image",
    apiURL: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    npm: "@ai-sdk/openai-compatible",
    inputImage: true,
    cost: 0,
  })
}

export const TripoProvider = {
  id: ProviderID.make("tripo"),
  name: "Tripo 3D",
  env: ["TRIPO_API_KEY", "CODEGOBLIN_TRIPO_API_KEY"],
  baseURL: "https://api.tripo3d.ai/v2/openapi",
} as const

export function tripoProviderInfo(): Info {
  return {
    id: TripoProvider.id,
    name: TripoProvider.name,
    source: "custom",
    env: [...TripoProvider.env],
    options: {
      baseURL: TripoProvider.baseURL,
      name: "tripo",
    },
    models: {},
  }
}

export function augment3DModelCatalog(catalog: Record<string, Info>) {
  ensureTripoProvider(catalog)
  add3DModel(catalog, "tripo", "text-to-model", {
    name: "Tripo Text to 3D",
    family: "tripo-h3",
    inputImage: false,
  })
  add3DModel(catalog, "tripo", "image-to-model", {
    name: "Tripo Image to 3D",
    family: "tripo-h3",
    inputImage: true,
  })
}

function ensureTripoProvider(catalog: Record<string, Info>) {
  catalog.tripo ??= tripoProviderInfo()
  const provider = catalog.tripo
  for (const env of TripoProvider.env) {
    if (!provider.env.includes(env)) provider.env.push(env)
  }
  provider.options.baseURL ??= TripoProvider.baseURL
  provider.options.name ??= "tripo"
}

function add3DModel(
  catalog: Record<string, Info>,
  providerID: string,
  modelID: string,
  opts: {
    name: string
    family: string
    inputImage: boolean
  },
) {
  const provider = catalog[providerID]
  if (!provider || provider.models[modelID]) return
  const id = ProviderID.make(providerID)
  provider.models[modelID] = {
    id: ModelID.make(modelID),
    providerID: id,
    name: opts.name,
    family: opts.family,
    api: {
      id: modelID,
      npm: "@ai-sdk/openai-compatible",
      url: TripoProvider.baseURL,
    },
    status: "active",
    headers: {},
    options: {},
    capabilities: {
      temperature: false,
      reasoning: false,
      attachment: false,
      toolcall: false,
      input: {
        text: !opts.inputImage,
        audio: false,
        image: opts.inputImage,
        video: false,
        pdf: false,
      },
      output: {
        text: false,
        audio: false,
        image: false,
        video: false,
        pdf: false,
        model3d: true,
      } as Model["capabilities"]["output"],
      interleaved: false,
    },
    cost: {
      input: 0,
      output: 0,
      cache: {
        read: 0,
        write: 0,
      },
    },
    limit: {
      context: 2_000,
      output: 0,
    },
    release_date: "",
    variants: {
      "v3.1-20260211": { name: "Tripo H3 v3.1" },
      "v3.0-20250812": { name: "Tripo H3 v3.0" },
    },
  }
}

export function augmentAudioModelCatalog(catalog: Record<string, Info>) {
  ensureAudioProvider(catalog, "elevenlabs")
  addAudioModel(catalog, "elevenlabs", "eleven_multilingual_v2", {
    name: "ElevenLabs Text to Speech",
    family: "elevenlabs",
    apiURL: "https://api.elevenlabs.io/v1",
  })
  addAudioModel(catalog, "elevenlabs", "eleven_turbo_v2_5", {
    name: "ElevenLabs Turbo 2.5",
    family: "elevenlabs",
    apiURL: "https://api.elevenlabs.io/v1",
  })
  addAudioModel(catalog, "elevenlabs", "elevenlabs-music", {
    name: "ElevenLabs Music",
    family: "elevenlabs",
    apiURL: "https://api.elevenlabs.io/v1",
  })
}

function ensureAudioProvider(catalog: Record<string, Info>, providerID: "elevenlabs") {
  catalog[providerID] ??= elevenLabsProviderInfo()
  const provider = catalog[providerID]
  for (const env of ElevenLabsProvider.env) {
    if (!provider.env.includes(env)) provider.env.push(env)
  }
  provider.options.baseURL ??= ElevenLabsProvider.baseURL
  provider.options.name ??= "elevenlabs"
}

function addImageModel(
  catalog: Record<string, Info>,
  providerID: string,
  modelID: string,
  opts: {
    name: string
    family: string
    apiURL: string
    npm: string
    inputImage: boolean
    cost: number
  },
) {
  const provider = catalog[providerID]
  if (!provider || provider.models[modelID]) return
  const id = ProviderID.make(providerID)
  provider.models[modelID] = {
    id: ModelID.make(modelID),
    providerID: id,
    name: opts.name,
    family: opts.family,
    api: {
      id: modelID,
      npm: opts.npm,
      url: opts.apiURL,
    },
    status: "active",
    headers: {},
    options: {},
    capabilities: {
      temperature: false,
      reasoning: false,
      attachment: false,
      toolcall: false,
      input: {
        text: true,
        audio: false,
        image: opts.inputImage,
        video: false,
        pdf: false,
      },
      output: {
        text: false,
        audio: false,
        image: true,
        video: false,
        pdf: false,
      },
      interleaved: false,
    },
    cost: {
      input: opts.cost,
      output: 0,
      cache: {
        read: 0,
        write: 0,
      },
    },
    limit: {
      context: 8_000,
      output: 1_000,
    },
    release_date: "",
    variants: {},
  }
}

function addAudioModel(
  catalog: Record<string, Info>,
  providerID: string,
  modelID: string,
  opts: {
    name: string
    family: string
    apiURL: string
  },
) {
  const provider = catalog[providerID]
  if (!provider || provider.models[modelID]) return
  const id = ProviderID.make(providerID)
  provider.models[modelID] = {
    id: ModelID.make(modelID),
    providerID: id,
    name: opts.name,
    family: opts.family,
    api: {
      id: modelID,
      npm: "@ai-sdk/openai-compatible",
      url: opts.apiURL,
    },
    status: "active",
    headers: {},
    options: {},
    capabilities: {
      temperature: false,
      reasoning: false,
      attachment: false,
      toolcall: false,
      input: {
        text: true,
        audio: false,
        image: false,
        video: false,
        pdf: false,
      },
      output: {
        text: false,
        audio: true,
        image: false,
        video: false,
        pdf: false,
      },
      interleaved: false,
    },
    cost: {
      input: 0,
      output: 0,
      cache: {
        read: 0,
        write: 0,
      },
    },
    limit: {
      context: 5_000,
      output: 0,
    },
    release_date: "",
    variants: {},
  }
}

export function codeGoblinProviderSummary() {
  return [
    "Provider: codegoblin",
    `Default mock gateway: ${CodeGoblinProvider.baseURL}`,
    "Models: deepseek-chat, goblin-mock, goblin-image-mock, qwen-image-pro, qwen-image-edit, elevenlabs-tts, elevenlabs-music",
    "Env: CODEGOBLIN_GATEWAY_URL, CODEGOBLIN_API_KEY or CODEGOBLIN_GATEWAY_KEY; image/audio helpers use provider-specific local keys when selected.",
    "Status: scaffold only; production hosted keys, Stripe, and pricing logic are intentionally private.",
  ].join("\n")
}
