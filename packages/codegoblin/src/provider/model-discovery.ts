import type { Info, Model } from "./provider"
import { ModelID } from "./schema"
import { Global } from "@codegoblin/core/global"
import { Hash } from "@codegoblin/core/util/hash"
import path from "path"

type Source = {
  url: string
  auth: "bearer" | "anthropic" | "google" | "optional"
  format?: "google"
}

const sources: Record<string, Source> = {
  opencode: { url: "https://opencode.ai/zen/v1/models", auth: "optional" },
  openrouter: { url: "https://openrouter.ai/api/v1/models", auth: "optional" },
  openai: { url: "https://api.openai.com/v1/models", auth: "bearer" },
  anthropic: { url: "https://api.anthropic.com/v1/models?limit=1000", auth: "anthropic" },
  google: {
    url: "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000",
    auth: "google",
    format: "google",
  },
  xai: { url: "https://api.x.ai/v1/models", auth: "bearer" },
  mistral: { url: "https://api.mistral.ai/v1/models", auth: "bearer" },
  moonshotai: { url: "https://api.moonshot.ai/v1/models", auth: "bearer" },
  deepseek: { url: "https://api.deepseek.com/models", auth: "bearer" },
  zai: { url: "https://api.z.ai/api/paas/v4/models", auth: "bearer" },
  "zai-coding-plan": { url: "https://api.z.ai/api/coding/paas/v4/models", auth: "bearer" },
  zhipuai: { url: "https://open.bigmodel.cn/api/paas/v4/models", auth: "bearer" },
  "zhipuai-coding-plan": { url: "https://open.bigmodel.cn/api/paas/v4/models", auth: "bearer" },
  groq: { url: "https://api.groq.com/openai/v1/models", auth: "bearer" },
  togetherai: { url: "https://api.together.xyz/v1/models", auth: "bearer" },
  cerebras: { url: "https://api.cerebras.ai/v1/models", auth: "bearer" },
  cohere: { url: "https://api.cohere.com/v1/models?page_size=1000", auth: "bearer" },
  venice: { url: "https://api.venice.ai/api/v1/models", auth: "bearer" },
  deepinfra: { url: "https://api.deepinfra.com/v1/openai/models", auth: "bearer" },
}

const unsupported = /(embedding|moderation|whisper|transcri|text-to-speech|\btts\b|dall-e|realtime)/i
const ttl = 5 * 60_000
const unavailableTtl = 60 * 60_000
const maxModels = 5_000
const maxResponseChars = 2_000_000

type Cache = {
  updatedAt: number
  ids: string[]
}

type HealthCache = Record<string, number>
type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

export function supportsNativeModelDiscovery(providerID: string) {
  return providerID in sources
}

export async function cachedNativeModelIDs(provider: Info) {
  const cache: Cache | undefined = await Bun.file(cachePath(provider))
    .json()
    .catch(() => undefined)
  if (!cache || !Array.isArray(cache.ids) || typeof cache.updatedAt !== "number") return
  if (Date.now() - cache.updatedAt >= ttl) return
  return cache.ids.filter((id): id is string => typeof id === "string")
}

export async function cacheNativeModelIDs(provider: Info, ids: string[]) {
  await Bun.write(cachePath(provider), JSON.stringify({ updatedAt: Date.now(), ids: ids.slice(0, maxModels) } satisfies Cache))
}

export async function unavailableNativeModelIDs(provider: Info) {
  return Object.keys(await healthCache(provider))
}

export async function markNativeModelUnavailable(provider: Info, modelID: string) {
  await Bun.write(healthCachePath(provider), JSON.stringify({ ...(await healthCache(provider)), [modelID]: Date.now() }))
}

export function isNativeModelUnavailableError(input: unknown) {
  const text = errorText(input, new WeakSet())
  if (/\b(?:408|425|429|500|502|503|504)\b|rate.?limit|temporar|timeout|timed out|overload/i.test(text)) return false
  return (
    /model (?:is )?unavailable/i.test(text) ||
    /model[_ -]?not[_ -]?found/i.test(text) ||
    /no (?:such|available) model/i.test(text) ||
    /does not exist or you do not have access/i.test(text)
  )
}

export async function discoverNativeModelIDs(
  provider: Info,
  fetcher: Fetcher = (input, init) => globalThis.fetch(input, init),
) {
  const source = sources[provider.id]
  if (!source) return

  const key = provider.key ?? (typeof provider.options.apiKey === "string" ? provider.options.apiKey : undefined)
  if (source.auth !== "optional" && !key) return

  const headers = new Headers({ Accept: "application/json" })
  if (source.auth === "bearer" && key) headers.set("Authorization", `Bearer ${key}`)
  if (source.auth === "anthropic" && key) {
    headers.set("x-api-key", key)
    headers.set("anthropic-version", "2023-06-01")
  }
  if (source.auth === "google" && key) headers.set("x-goog-api-key", key)
  if (source.auth === "optional" && key) headers.set("Authorization", `Bearer ${key}`)

  const response = await fetcher(source.url, {
    headers,
    signal: AbortSignal.timeout(3_000),
  })
  if (!response.ok) throw new Error(`${provider.id} model discovery returned HTTP ${response.status}`)

  const length = Number(response.headers.get("content-length"))
  if (Number.isFinite(length) && length > maxResponseChars) {
    throw new Error(`${provider.id} model discovery response exceeded ${maxResponseChars} bytes`)
  }
  const text = await response.text()
  if (text.length > maxResponseChars) {
    throw new Error(`${provider.id} model discovery response exceeded ${maxResponseChars} characters`)
  }
  const body = JSON.parse(text) as unknown
  const ids = parseNativeModelIDs(body, source.format)
  if (!ids.length) throw new Error(`${provider.id} model discovery returned no usable models`)
  return ids
}

export function parseNativeModelIDs(body: unknown, format?: Source["format"]) {
  if (!body || typeof body !== "object") return []
  const record = body as Record<string, unknown>
  const items = Array.isArray(body)
    ? body
    : Array.isArray(record.data)
      ? record.data
      : Array.isArray(record.models)
        ? record.models
        : []
  return Array.from(
    new Set(
      items.flatMap((item) => {
        if (!item || typeof item !== "object") return []
        const model = item as Record<string, unknown>
        if (
          format === "google" &&
          Array.isArray(model.supportedGenerationMethods) &&
          !model.supportedGenerationMethods.includes("generateContent")
        )
          return []
        const raw = typeof model.id === "string" ? model.id : typeof model.name === "string" ? model.name : undefined
        if (!raw) return []
        const id = format === "google" ? raw.replace(/^models\//, "") : raw
        if (!id || unsupported.test(id)) return []
        return [id]
      }),
    ),
  ).sort().slice(0, maxModels)
}

export function mergeNativeModels(provider: Info, liveIDs: string[], configuredIDs: string[] = []) {
  const live = new Set(liveIDs)
  const configured = new Set(configuredIDs)
  const models = Object.fromEntries(
    Object.entries(provider.models).filter(([id, model]) => configured.has(id) || live.has(id) || live.has(model.api.id)),
  )

  for (const id of liveIDs) {
    if (Object.values(models).some((model) => model.api.id === id)) continue
    const template = closestTemplate(provider.models, id)
    if (!template) continue
    models[id] = {
      ...structuredClone(template),
      id: ModelID.make(id),
      api: { ...template.api, id },
      name: displayName(id),
      status: "active",
      cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
      release_date: "",
      variants: {},
    }
  }
  return models
}

function closestTemplate(models: Record<string, Model>, id: string) {
  return Object.values(models).sort((a, b) => sharedPrefix(b.api.id, id) - sharedPrefix(a.api.id, id))[0]
}

function sharedPrefix(a: string, b: string) {
  const length = Math.min(a.length, b.length)
  for (let i = 0; i < length; i++) if (a[i] !== b[i]) return i
  return length
}

function displayName(id: string) {
  return id
    .split("/")
    .at(-1)!
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (value) => value.toUpperCase())
}

function cachePath(provider: Info) {
  const key = provider.key ?? (typeof provider.options.apiKey === "string" ? provider.options.apiKey : "public")
  return path.join(Global.Path.cache, `native-models-${Hash.fast(`${provider.id}:${key}`)}.json`)
}

function healthCachePath(provider: Info) {
  const key = provider.key ?? (typeof provider.options.apiKey === "string" ? provider.options.apiKey : "public")
  return path.join(Global.Path.cache, `native-model-health-${Hash.fast(`${provider.id}:${key}`)}.json`)
}

async function healthCache(provider: Info) {
  const cache: HealthCache | undefined = await Bun.file(healthCachePath(provider))
    .json()
    .catch(() => undefined)
  if (!cache || typeof cache !== "object") return {}
  return Object.fromEntries(
    Object.entries(cache).filter(
      (entry): entry is [string, number] => typeof entry[1] === "number" && Date.now() - entry[1] < unavailableTtl,
    ),
  )
}

function errorText(input: unknown, seen: WeakSet<object>): string {
  if (typeof input === "string") return input
  if (!input || typeof input !== "object") return ""
  if (seen.has(input)) return ""
  seen.add(input)
  if (input instanceof Error) return `${input.message} ${errorText(input.cause, seen)}`
  return Object.values(input as Record<string, unknown>)
    .map((value) => errorText(value, seen))
    .join(" ")
}
