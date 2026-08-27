/**
 * Providers, written from scratch.
 *
 * All of these speak the OpenAI chat-completions wire format, so one client
 * covers them and adding another is an entry here, not an integration.
 *
 * Models are the agentic ones - the flash tiers are fast enough to feel
 * responsive in a TUI while still driving tools reliably.
 */
export type Provider = {
  id: string
  label: string
  baseUrl: string
  model: string
}

export const PROVIDERS: Record<string, Provider> = {
  deepseek: {
    id: "deepseek",
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com/chat/completions",
    model: "deepseek-v4-flash",
  },
  zai: {
    id: "zai",
    label: "GLM",
    baseUrl: "https://api.z.ai/api/paas/v4/chat/completions",
    model: "glm-4.7-flash",
  },
  moonshotai: {
    id: "moonshotai",
    label: "Kimi",
    baseUrl: "https://api.moonshot.cn/v1/chat/completions",
    model: "kimi-k3",
  },
}

export const DEFAULT_PROVIDER = "deepseek"

export function resolveProvider(id?: string): Provider {
  return PROVIDERS[id ?? DEFAULT_PROVIDER] ?? PROVIDERS[DEFAULT_PROVIDER]!
}
