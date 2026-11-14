import type { Provider } from "./providers"
import { installedModels, toolsFor } from "./local-runtime"

export async function verifyLocalModel(provider: Provider, modelId: string, signal?: AbortSignal) {
  if (!provider.local || !provider.baseUrl) return
  const response = await fetch(provider.baseUrl.replace(/\/chat\/completions$/, "/models"), {
    // CG-Next's own server answers only to the key it was started with.
    headers: provider.auth?.("") ?? {},
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

/**
 * Whether a local model gets the lean chat prompt and no tools.
 *
 * The external server decides once, by environment. CG-Next's own runtime
 * decides per model, since it serves whichever one was picked.
 */
export function isLocalChat(provider: Provider, modelId: string): boolean {
  if (!provider.local) return false
  if (!provider.runtime) return !provider.localTools
  const file = installedModels().find((model) => model.id === modelId)
  return !(file && toolsFor(file).on)
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
  // A loopback server can be a proxy in front of a paid model. CODEGOBLIN_LOCAL_PRICE
  // ("input,output" or "input,output,cacheRead", dollars per million tokens) and
  // CODEGOBLIN_LOCAL_CACHE_MINUTES say what is behind it, so spend and idle compaction work.
  const numbers = (env.CODEGOBLIN_LOCAL_PRICE ?? "").split(",").map((part) => Number(part.trim()))
  if (env.CODEGOBLIN_LOCAL_PRICE && (numbers.length < 2 || numbers.length > 3 || numbers.some((each) => !Number.isFinite(each) || each < 0))) throw new Error("CODEGOBLIN_LOCAL_PRICE must be input,output or input,output,cacheRead in dollars per million tokens")
  const price = env.CODEGOBLIN_LOCAL_PRICE ? { input: numbers[0]!, output: numbers[1]!, ...(numbers[2] !== undefined ? { cacheRead: numbers[2] } : {}) } : { input: 0, output: 0 }
  const cacheMinutes = Number(env.CODEGOBLIN_LOCAL_CACHE_MINUTES ?? "")
  if (env.CODEGOBLIN_LOCAL_CACHE_MINUTES && !(cacheMinutes > 0)) throw new Error("CODEGOBLIN_LOCAL_CACHE_MINUTES must be a number of minutes above 0")
  return {
    id: "local", label: "Local server", baseUrl: url.href, local: true,
    ...(env.CODEGOBLIN_LOCAL_CACHE_MINUTES ? { cacheMinutes } : {}),
    localTools: env.CODEGOBLIN_LOCAL_TOOLS === "1",
    ...(env.CODEGOBLIN_LOCAL_THINKING ? { localThinking: env.CODEGOBLIN_LOCAL_THINKING === "1" } : {}),
    auth: () => ({}),
    models: [{ id, label: id + (env.CODEGOBLIN_LOCAL_TOOLS === "1" ? " (local tools)" : " (local chat)"), contextWindow, price }],
  }
}
