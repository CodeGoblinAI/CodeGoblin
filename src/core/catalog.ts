import fs from "node:fs"
import path from "node:path"
import { Global } from "../platform/paths"
import type { Model, Provider } from "./providers"
import type { Price } from "./context"

/**
 * Provider breadth from models.dev, the open catalog the fork reads.
 *
 * CG-Next's own catalogue is the providers it knows by hand; models.dev lists
 * a couple of hundred more. Every one that speaks OpenAI chat completions -
 * most of them, and a handful more whose endpoint is well known - can be used
 * as it is: a base URL, a bearer key, a model id. They join the picker once
 * there is a key for them (stored with /connect, or in the environment under
 * the name models.dev gives), so the list is not flooded with providers you
 * cannot call. The ids are models.dev's, the same the fork stores keys under,
 * so a key saved in either app works in both. Hand-written providers always
 * win over a catalog entry of the same id.
 *
 * Fetched at most once a day and cached, trimmed to what is used; a fetch
 * that fails keeps the cache, and no cache means only the built-ins.
 */
const URL_ = "https://models.dev/api.json"
const MAX_AGE_MS = 24 * 60 * 60 * 1000
const cacheFile = () => path.join(Global.Path.cache, "models-dev.json")

/** Providers whose package is not the generic OpenAI-compatible one, but whose OpenAI-compatible endpoint is documented. */
const KNOWN_BASE: Record<string, string> = {
  openai: "https://api.openai.com/v1",
  groq: "https://api.groq.com/openai/v1",
  xai: "https://api.x.ai/v1",
  togetherai: "https://api.together.xyz/v1",
  mistral: "https://api.mistral.ai/v1",
  cerebras: "https://api.cerebras.ai/v1",
  "fireworks-ai": "https://api.fireworks.ai/inference/v1",
  google: "https://generativelanguage.googleapis.com/v1beta/openai",
  deepinfra: "https://api.deepinfra.com/v1/openai",
  perplexity: "https://api.perplexity.ai",
}

export type CatalogProvider = { id: string; label: string; env: string[]; baseUrl: string; doc?: string; models: Model[] }

type RawModel = {
  id?: unknown; name?: unknown; reasoning?: unknown; tool_call?: unknown; status?: unknown
  limit?: { context?: unknown }; cost?: { input?: unknown; output?: unknown; cache_read?: unknown }
  modalities?: { input?: unknown; output?: unknown }
}
type RawProvider = { id?: unknown; name?: unknown; env?: unknown; npm?: unknown; api?: unknown; doc?: unknown; models?: Record<string, RawModel> }

const str = (value: unknown, max = 200) => (typeof value === "string" && value.length <= max ? value : undefined)

function priceFrom(cost: RawModel["cost"]): Price | undefined {
  if (!cost || typeof cost.input !== "number" || typeof cost.output !== "number" || cost.input < 0 || cost.output < 0) return undefined
  const read = cost.cache_read
  return { input: cost.input, output: cost.output, ...(typeof read === "number" && read >= 0 && read <= cost.input ? { cacheRead: read } : {}) }
}

/** The hand-written providers whose prices the catalog keeps current. */
const PRICED_BUILT_INS = ["deepseek", "zai", "moonshotai", "openai", "xiaomi", "meta"]

/** Prices for the built-in providers' models, by provider and model id. A free or unpriced entry is left out. */
export function builtInPrices(raw: unknown): Record<string, Record<string, Price>> {
  const out: Record<string, Record<string, Price>> = {}
  if (!raw || typeof raw !== "object") return out
  for (const id of PRICED_BUILT_INS) {
    const models = (raw as Record<string, RawProvider>)[id]?.models
    if (!models || typeof models !== "object") continue
    for (const model of Object.values(models)) {
      const modelId = str(model?.id)
      const price = priceFrom(model?.cost)
      if (!modelId || !price || (price.input === 0 && price.output === 0)) continue
      ;(out[id] ??= {})[modelId] = price
    }
  }
  return out
}

/** The catalog, kept to providers CG-Next can call and models an agent can use: text out, tool calls, not deprecated. */
export function usableCatalog(raw: unknown): CatalogProvider[] {
  if (!raw || typeof raw !== "object") return []
  const out: CatalogProvider[] = []
  for (const [key, value] of Object.entries(raw as Record<string, RawProvider>)) {
    const id = str(value?.id) ?? key
    if (!/^[a-z0-9][a-z0-9._-]{0,60}$/.test(id)) continue
    const api = str(value.api, 300)
    const baseUrl = value.npm === "@ai-sdk/openai-compatible" && api ? api : KNOWN_BASE[id] ?? (id === "openrouter" ? api : undefined)
    if (!baseUrl || !/^https:\/\/[^\s]+$/.test(baseUrl)) continue
    const models: Model[] = []
    for (const model of Object.values(value.models ?? {})) {
      const modelId = str(model?.id)
      if (!modelId || !/^[A-Za-z0-9._:/@+-]{1,160}$/.test(modelId)) continue
      const output = Array.isArray(model.modalities?.output) ? model.modalities!.output as unknown[] : ["text"]
      if (model.tool_call !== true || !output.includes("text") || model.status === "deprecated") continue
      const input = Array.isArray(model.modalities?.input) ? model.modalities!.input as unknown[] : ["text"]
      const context = typeof model.limit?.context === "number" && model.limit.context > 0 ? model.limit.context : 128_000
      const cost = priceFrom(model.cost)
      models.push({
        id: modelId,
        label: str(model.name, 120) ?? modelId,
        contextWindow: context,
        ...(model.reasoning === true ? { reasoning: true } : {}),
        ...(cost ? { price: cost } : {}),
        capabilities: { input: { text: true, ...(input.includes("image") ? { image: true } : {}) } },
      })
    }
    if (!models.length) continue
    const env = Array.isArray(value.env) ? (value.env as unknown[]).filter((name): name is string => typeof name === "string" && /^[A-Z][A-Z0-9_]{1,60}$/.test(name)) : []
    out.push({ id, label: str(value.name, 80) ?? id, env, baseUrl: baseUrl.replace(/\/+$/, ""), ...(str(value.doc, 300) ? { doc: str(value.doc, 300) } : {}), models })
  }
  return out.sort((a, b) => a.label.localeCompare(b.label))
}

type Cached = { at: number; providers: CatalogProvider[]; prices?: Record<string, Record<string, Price>> }
function readCache(): Cached | undefined {
  try {
    const cached = JSON.parse(fs.readFileSync(cacheFile(), "utf8")) as { at?: unknown; providers?: unknown; prices?: unknown }
    if (typeof cached.at !== "number" || !Array.isArray(cached.providers)) return undefined
    const prices = cached.prices && typeof cached.prices === "object" ? (cached.prices as Cached["prices"]) : undefined
    return { at: cached.at, providers: cached.providers as CatalogProvider[], ...(prices ? { prices } : {}) }
  } catch {
    return undefined
  }
}

/** Built-in providers' prices from the last catalog that loaded; empty until one has. */
let prices: Record<string, Record<string, Price>> = {}
export function catalogPrices() {
  return prices
}

/** The usable catalog: from the cache when it is fresh, else fetched (and cached), else whatever cache there is. */
export async function loadCatalog(options: { fetch?: typeof fetch; now?: number; force?: boolean } = {}): Promise<CatalogProvider[]> {
  const now = options.now ?? Date.now()
  const cached = readCache()
  prices = cached?.prices ?? {}
  // A cache written before prices were kept is refetched once, to get them.
  if (cached?.prices && !options.force && now - cached.at < MAX_AGE_MS) return cached.providers
  try {
    const response = await (options.fetch ?? fetch)(URL_, { signal: AbortSignal.timeout(15_000), redirect: "error" })
    if (!response.ok) throw new Error(String(response.status))
    const raw = await response.json()
    const providers = usableCatalog(raw)
    if (providers.length) {
      prices = builtInPrices(raw)
      fs.mkdirSync(path.dirname(cacheFile()), { recursive: true })
      fs.writeFileSync(cacheFile(), JSON.stringify({ at: now, providers, prices }))
    }
    return providers.length ? providers : cached?.providers ?? []
  } catch {
    return cached?.providers ?? []
  }
}

/** The environment variables models.dev names for a provider's key, once the catalog is loaded. */
const envNames = new Map<string, string[]>()
export function catalogEnv(id: string): string[] {
  return envNames.get(id) ?? []
}
export function rememberCatalogEnv(providers: CatalogProvider[]) {
  for (const provider of providers) if (provider.env.length) envNames.set(provider.id, provider.env)
}

/** A catalog entry as a provider the agent can call. */
export function asProvider(entry: CatalogProvider): Provider {
  return { id: entry.id, label: entry.label, baseUrl: entry.baseUrl + "/chat/completions", usageOnStream: true, models: entry.models.map((model) => ({ ...model })) }
}
