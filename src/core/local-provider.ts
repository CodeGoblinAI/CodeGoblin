import type { Provider } from "./providers"

export async function verifyLocalModel(provider: Provider, modelId: string, signal?: AbortSignal) {
  if (!provider.local || !provider.baseUrl) return
  const response = await fetch(provider.baseUrl.replace(/\/chat\/completions$/, "/models"), {
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000),
  }).catch((error: unknown) => {
    if (signal?.aborted) throw error
    throw new Error(`Cannot reach the local model server at ${provider.baseUrl}. Start it and wait until it is ready.`, { cause: error })
  })
  if (!response.ok) throw new Error(`Local model discovery returned ${response.status}; check the server before sending a prompt.`)
  const catalog = await response.json() as { data?: { id?: string; aliases?: string[] }[] }
  if (!Array.isArray(catalog.data) || !catalog.data.some((model) => model.id === modelId || model.aliases?.includes(modelId))) {
    throw new Error(`Local model mismatch: selected ${modelId}, but the server reports ${(catalog.data ?? []).map((model) => model.id).join(", ") || "no models"}. Check the port/model alias; no chat request was sent.`)
  }
}

/** Opt-in only: never discover or take ownership of the fork's running server. */
export function localProvider(env: Record<string, string | undefined> = process.env): Provider | undefined {
  if (!env.CODEGOBLIN_LOCAL_URL) return undefined
  const url = new URL(env.CODEGOBLIN_LOCAL_URL)
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.username || url.password || url.search || url.hash) {
    throw new Error("CODEGOBLIN_LOCAL_URL must be an unauthenticated HTTP loopback URL")
  }
  url.pathname = url.pathname.replace(/\/$/, "")
  if (!url.pathname.endsWith("/chat/completions")) url.pathname += "/chat/completions"
  const id = env.CODEGOBLIN_LOCAL_MODEL?.trim()
  if (!id) throw new Error("Set CODEGOBLIN_LOCAL_MODEL to the model ID served by the local server")
  const contextWindow = Number(env.CODEGOBLIN_LOCAL_CONTEXT ?? "4096")
  if (!Number.isInteger(contextWindow) || contextWindow < 512) throw new Error("CODEGOBLIN_LOCAL_CONTEXT must be an integer of at least 512")
  if (env.CODEGOBLIN_LOCAL_TOOLS && !["0", "1"].includes(env.CODEGOBLIN_LOCAL_TOOLS)) throw new Error("CODEGOBLIN_LOCAL_TOOLS must be 0 or 1")
  if (env.CODEGOBLIN_LOCAL_THINKING && !["0", "1"].includes(env.CODEGOBLIN_LOCAL_THINKING)) throw new Error("CODEGOBLIN_LOCAL_THINKING must be 0 or 1")
  return {
    id: "local", label: "Local", baseUrl: url.href, local: true,
    localTools: env.CODEGOBLIN_LOCAL_TOOLS === "1",
    ...(env.CODEGOBLIN_LOCAL_THINKING ? { localThinking: env.CODEGOBLIN_LOCAL_THINKING === "1" } : {}),
    auth: () => ({}),
    models: [{ id, label: id + (env.CODEGOBLIN_LOCAL_TOOLS === "1" ? " (local tools)" : " (local chat)"), contextWindow, price: { input: 0, output: 0 } }],
  }
}
