/**
 * Providers and models.
 *
 * All of these speak the OpenAI chat-completions wire format, so one client
 * covers them. Model ids come from each provider's /models endpoint rather
 * than a bundled catalog - the catalog lags, and once claimed glm-5.3 did not
 * exist when it did.
 *
 * `reasoning` marks models that stream a thinking channel, so the UI can show
 * it separately from the answer.
 */
export type Model = {
  id: string
  label: string
  reasoning?: boolean
  /** Context window in tokens; drives when a conversation is compacted. */
  contextWindow: number
}

export type Provider = {
  id: string
  label: string
  baseUrl: string
  models: Model[]
}

export const PROVIDERS: Record<string, Provider> = {
  deepseek: {
    id: "deepseek",
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com/chat/completions",
    models: [
      { id: "deepseek-v4-flash", label: "V4 Flash", contextWindow: 128000 },
      { id: "deepseek-v4-pro", label: "V4 Pro", reasoning: true, contextWindow: 128000 },
      { id: "deepseek-v4-flash-vision-exp", label: "V4 Flash Vision", contextWindow: 128000 },
    ],
  },
  zai: {
    id: "zai",
    label: "GLM",
    baseUrl: "https://api.z.ai/api/paas/v4/chat/completions",
    models: [
      { id: "glm-5.3-flash", label: "5.3 Flash", contextWindow: 128000 },
      { id: "glm-5.3", label: "5.3", reasoning: true, contextWindow: 200000 },
      { id: "glm-5.2", label: "5.2", reasoning: true, contextWindow: 128000 },
      { id: "glm-5.1", label: "5.1", contextWindow: 128000 },
      { id: "glm-5", label: "5", contextWindow: 128000 },
      { id: "glm-5-turbo", label: "5 Turbo", contextWindow: 128000 },
      { id: "glm-4.7", label: "4.7", contextWindow: 128000 },
      { id: "glm-4.6", label: "4.6", contextWindow: 128000 },
    ],
  },
  moonshotai: {
    id: "moonshotai",
    label: "Kimi",
    baseUrl: "https://api.moonshot.ai/v1/chat/completions",
    models: [
      { id: "kimi-k3", label: "K3", contextWindow: 256000 },
      { id: "kimi-k2.7-code", label: "K2.7 Code", contextWindow: 256000 },
      { id: "kimi-k2.7-code-highspeed", label: "K2.7 Code Highspeed", contextWindow: 256000 },
      { id: "kimi-k2.6", label: "K2.6", contextWindow: 128000 },
      { id: "kimi-k2.5", label: "K2.5", contextWindow: 128000 },
    ],
  },
}

export const DEFAULT_PROVIDER = "deepseek"

export type Selection = { provider: Provider; model: Model }

export function defaultSelection(): Selection {
  const provider = PROVIDERS[DEFAULT_PROVIDER]!
  return { provider, model: provider.models[0]! }
}

/** Accepts "zai", "glm-5.3", or "zai/glm-5.3". */
export function resolveSelection(input?: string): Selection | undefined {
  if (!input) return defaultSelection()
  const [head, tail] = input.includes("/") ? input.split("/") : [input, undefined]

  const byProvider = PROVIDERS[head!]
  if (byProvider) {
    const model = tail ? byProvider.models.find((m) => m.id === tail) : byProvider.models[0]
    return model ? { provider: byProvider, model } : undefined
  }

  for (const provider of Object.values(PROVIDERS)) {
    const model = provider.models.find((m) => m.id === input)
    if (model) return { provider, model }
  }
  return undefined
}

export function allSelections(): Selection[] {
  return Object.values(PROVIDERS).flatMap((provider) =>
    provider.models.map((model) => ({ provider, model })),
  )
}
