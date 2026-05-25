import { ModelID, ProviderID } from "@/provider/schema"
import type { Info, Model } from "@/provider/provider"

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
  },
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
        audio: false,
        image: (item.inputModalities as readonly string[]).includes("image"),
        video: false,
        pdf: false,
      },
      output: {
        text: (item.outputModalities as readonly string[]).includes("text"),
        audio: false,
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
    },
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

export function codeGoblinProviderSummary() {
  return [
    "Provider: codegoblin",
    `Default mock gateway: ${CodeGoblinProvider.baseURL}`,
    "Models: deepseek-chat, goblin-mock, goblin-image-mock",
    "Env: CODEGOBLIN_GATEWAY_URL, CODEGOBLIN_API_KEY or CODEGOBLIN_GATEWAY_KEY",
    "Status: scaffold only; production hosted keys, Stripe, and pricing logic are intentionally private.",
  ].join("\n")
}
