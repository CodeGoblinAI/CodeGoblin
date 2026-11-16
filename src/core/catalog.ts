import fs from "node:fs"
import path from "node:path"
import { Global } from "../platform/paths"
import type { Model, Provider } from "./providers"
import type { Price } from "./context"
import snapshot from "./catalog-snapshot.json"

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
/** CODEGOBLIN_MODELS_URL points somewhere else: a mirror, or nowhere, to see what a run without a connection does. */
const URL_ = process.env.CODEGOBLIN_MODELS_URL || "https://models.dev/api.json"
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

/** The built-in providers' models the catalog says take a picture as input, by provider. */
export function builtInVision(raw: unknown): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  if (!raw || typeof raw !== "object") return out
  for (const id of PRICED_BUILT_INS) {
    const models = (raw as Record<string, RawProvider>)[id]?.models
    if (!models || typeof models !== "object") continue
    const seeing = Object.values(models).flatMap((model) => {
      const modelId = str(model?.id)
      return modelId && Array.isArray(model.modalities?.input) && (model.modalities!.input as unknown[]).includes("image") ? [modelId] : []
    })
    if (seeing.length) out[id] = seeing
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

type Cached = { at: number; providers: CatalogProvider[]; prices?: Record<string, Record<string, Price>>; vision?: Record<string, string[]> }
function readCache(): Cached | undefined {
  try {
    const cached = JSON.parse(fs.readFileSync(cacheFile(), "utf8")) as { at?: unknown; providers?: unknown; prices?: unknown }
    if (typeof cached.at !== "number" || !Array.isArray(cached.providers)) return undefined
    const prices = cached.prices && typeof cached.prices === "object" ? (cached.prices as Cached["prices"]) : undefined
    const vision = (cached as { vision?: unknown }).vision
    return { at: cached.at, providers: cached.providers as CatalogProvider[], ...(prices ? { prices } : {}), ...(vision && typeof vision === "object" ? { vision: vision as Record<string, string[]> } : {}) }
  } catch {
    return undefined
  }
}

/** The catalogue as it was when this program was built (script/build.ts fills it in); empty from source. */
function bundledCatalog(): Cached | undefined {
  const carried = snapshot as unknown as Partial<Cached>
  if (!Array.isArray(carried.providers) || !carried.providers.length) return undefined
  return { at: typeof carried.at === "number" ? carried.at : 0, providers: carried.providers, prices: carried.prices ?? {}, vision: carried.vision ?? {} }
}

/** Built-in providers' prices from the last catalog that loaded; empty until one has. */
let prices: Record<string, Record<string, Price>> = {}
export function catalogPrices() {
  return prices
}
/** Built-in models that take pictures, from the last catalog that loaded. */
let vision: Record<string, string[]> = {}
export function catalogVision() {
  return vision
}

/** The usable catalog: from the cache when it is fresh, else fetched (and cached), else whatever cache there is. */
export async function loadCatalog(options: { fetch?: typeof fetch; now?: number; force?: boolean } = {}): Promise<CatalogProvider[]> {
  const now = options.now ?? Date.now()
  // With no cache yet - a first run - the catalogue the build carried stands in, so a first run with no
  // connection still lists every provider. From source it is empty and changes nothing.
  const cached = readCache() ?? bundledCatalog()
  prices = cached?.prices ?? {}
  vision = cached?.vision ?? {}
  // A cache written before prices or vision were kept is refetched once, to get them.
  if (cached?.prices && cached.vision && !options.force && now - cached.at < MAX_AGE_MS) return cached.providers
  try {
    const response = await (options.fetch ?? fetch)(URL_, { signal: AbortSignal.timeout(15_000), redirect: "error" })
    if (!response.ok) throw new Error(String(response.status))
    const raw = await response.json()
    const providers = usableCatalog(raw)
    if (providers.length) {
      prices = builtInPrices(raw)
      vision = builtInVision(raw)
      fs.mkdirSync(path.dirname(cacheFile()), { recursive: true })
      fs.writeFileSync(cacheFile(), JSON.stringify({ at: now, providers, prices, vision }))
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

/**
 * Where each catalog provider's key was first sent, by provider id.
 *
 * models.dev says where a provider's API is, and that list is fetched again every day. Without this, a
 * changed entry - a mistake there, or someone tampering with it - would send a key you connected for one
 * address to a different one on the next request, with nothing shown. So the address a key is first used
 * with is remembered, and a later catalog that names another host for the same provider is not followed:
 * requests keep going where they went before, a notice says so, and connecting the provider again (which is
 * you saying "yes, there") accepts the new address.
 */
const addressFile = () => path.join(Global.Path.state, "provider-addresses.json")
function readAddresses(): Record<string, string> {
  try {
    const saved = JSON.parse(fs.readFileSync(addressFile(), "utf8")) as unknown
    if (!saved || typeof saved !== "object" || Array.isArray(saved)) return {}
    return Object.fromEntries(Object.entries(saved).filter((pair): pair is [string, string] => typeof pair[1] === "string" && /^https:\/\/[^\s]+$/.test(pair[1])))
  } catch {
    return {}
  }
}
function writeAddresses(all: Record<string, string>) {
  try {
    fs.mkdirSync(path.dirname(addressFile()), { recursive: true })
    fs.writeFileSync(addressFile(), JSON.stringify(all, null, 2))
  } catch {
    // Not being able to remember is not a reason to stop working; the next run asks the same question.
  }
}
const hostOf = (url: string) => { try { return new URL(url).host.toLowerCase() } catch { return "" } }
const moved = new Map<string, { from: string; to: string }>()

/** Providers the catalog now places at another host than their key was connected for, as sentences. */
export function addressNotices(): string[] {
  return [...moved].map(([id, change]) => `${id}: the model catalog now lists this provider at ${change.to}, but its key was connected for ${change.from}. Still using ${change.from}. If the move is real, /connect ${id} again to accept it.`)
}

/** Forget the remembered address, so the catalog's current one is taken: the person has just connected it again. */
export function acceptAddress(id: string) {
  const all = readAddresses()
  if (id in all) { delete all[id]; writeAddresses(all) }
  moved.delete(id)
}

/** A catalog entry as a provider the agent can call, at the address its key was first used with. */
export function asProvider(entry: CatalogProvider): Provider {
  const all = readAddresses()
  const remembered = all[entry.id]
  let baseUrl = entry.baseUrl
  if (!remembered || hostOf(remembered) === hostOf(entry.baseUrl)) {
    moved.delete(entry.id)
    if (remembered !== entry.baseUrl) writeAddresses({ ...all, [entry.id]: entry.baseUrl })
  } else {
    baseUrl = remembered
    moved.set(entry.id, { from: hostOf(remembered), to: hostOf(entry.baseUrl) })
  }
  return { id: entry.id, label: entry.label, baseUrl: baseUrl + "/chat/completions", usageOnStream: true, models: entry.models.map((model) => ({ ...model })) }
}
