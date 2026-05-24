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
        text: item.inputModalities.includes("text"),
        audio: false,
        image: false,
        video: false,
        pdf: false,
      },
      output: {
        text: item.outputModalities.includes("text"),
        audio: false,
        image: false,
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
    },
  }
}

export function codeGoblinProviderSummary() {
  return [
    "Provider: codegoblin",
    `Default mock gateway: ${CodeGoblinProvider.baseURL}`,
    "Models: deepseek-chat, goblin-mock",
    "Env: CODEGOBLIN_GATEWAY_URL, CODEGOBLIN_API_KEY or CODEGOBLIN_GATEWAY_KEY",
    "Status: scaffold only; production hosted keys, Stripe, and pricing logic are intentionally private.",
  ].join("\n")
}
