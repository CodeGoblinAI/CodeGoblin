/**
 * Providers, written from scratch.
 *
 * All three speak the OpenAI chat-completions wire format, so one client
 * covers them. Adding another is a line here, not a new integration.
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
    model: "deepseek-chat",
  },
  zai: {
    id: "zai",
    label: "GLM",
    baseUrl: "https://api.z.ai/api/paas/v4/chat/completions",
    model: "glm-4.6",
  },
  moonshotai: {
    id: "moonshotai",
    label: "Kimi",
    baseUrl: "https://api.moonshot.cn/v1/chat/completions",
    model: "moonshot-v1-8k",
  },
}

export const DEFAULT_PROVIDER = "deepseek"
