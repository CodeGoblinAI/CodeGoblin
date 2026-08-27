/**
 * Providers, written from scratch.
 *
 * All of these speak the OpenAI chat-completions wire format, so one client
 * covers them and adding another is an entry here, not an integration.
 *
 * Model ids come from each providers /models endpoint, not the bundled
 * catalog - the catalog lags. glm-5.3-flash is current; the catalog still
 * listed 4.7 as newest.
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
    model: "glm-5.3-flash",
  },
  moonshotai: {
    id: "moonshotai",
    label: "Kimi",
    baseUrl: "https://api.moonshot.ai/v1/chat/completions",
    model: "kimi-k3",
  },
}

export const DEFAULT_PROVIDER = "deepseek"

export function resolveProvider(id?: string): Provider {
  return PROVIDERS[id ?? DEFAULT_PROVIDER] ?? PROVIDERS[DEFAULT_PROVIDER]!
}
