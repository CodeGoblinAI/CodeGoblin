/**
 * Providers and models.
 *
 * HTTP text providers speak the OpenAI chat-completions wire format; CLI
 * providers use their official process protocol. Model ids come from each provider's /models endpoint rather
 * than a bundled catalog - the catalog lags, and once claimed glm-5.3 did not
 * exist when it did.
 *
 * `reasoning` marks models that stream a thinking channel, so the UI can show
 * it separately from the answer.
 */
/**
 * What a model can take in and give back.
 *
 * This is what puts a model in the right section of the picker, and what
 * decides whether a prompt becomes a sentence, a picture, a sound or a mesh.
 * Absent means text in, text out - the ordinary case.
 */
import { localProvider } from "./local-provider"
import { contextFor, installedModels, readPrefs, toolsFor } from "./local-runtime"
import { cachedExperientialModels, fetchExperientialModels } from "./experiential"
import { cachedRefuselessModels, fetchRefuselessModels } from "./refuseless"
import { EFFORT_NAMES } from "./settings"
import { acceptAddress, addressNotices, asProvider, catalogPrices, catalogVision, loadCatalog, rememberCatalogEnv, type CatalogProvider } from "./catalog"
import type { Price } from "./context"

export type Capabilities = {
  input?: { text?: boolean; image?: boolean; audio?: boolean }
  output?: { text?: boolean; image?: boolean; audio?: boolean; model3d?: boolean }
}

export type Model = {
  id: string
  label: string
  reasoning?: boolean
  /** Context window in tokens; drives when a conversation is compacted. */
  contextWindow: number
  /**
   * Whether this model accepts a reasoning_effort.
   *
   * There is no way to ask a provider this - nothing in /models reports it -
   * so it has to be declared. Defaults to `reasoning`, which is the right
   * guess and not the same claim: a model can stream a thinking channel
   * without taking direction on how long to spend in it. When one of those
   * turns up, say `effort: false` on it rather than lying about `reasoning`.
   */
  effort?: boolean
  /**
   * The effort levels this model's API accepts, weakest first, under the
   * names it uses. Models do not share one ladder: Z.ai's GLM takes none to
   * max and defaults to max, DeepSeek takes none/low/high/max and defaults to
   * high, Codex models report up to ultra. So "high" is a different amount on
   * each, and nothing is translated between them. Absent with `effort` (or
   * `reasoning`) means the standard three.
   */
  efforts?: string[]
  /** What the API does when no effort is sent - what "auto" means for this model, when it is documented. */
  defaultEffort?: string
  /**
   * US dollars per million tokens, in and out.
   *
   * Absent means unpriced rather than free - a spend of nothing and a spend
   * nobody has told us are different things, and the status line says which.
   */
  price?: Price
  capabilities?: Capabilities
}

export type Provider = {
  cli?: "claude-code" | "codex" | "cursor" | "cursor-api"
  local?: boolean
  /**
   * Served by CG-Next's own llama-server, started for whichever model is
   * picked. Its endpoint exists only once that server is up, so baseUrl is
   * absent until a turn leases it - see local-runtime.ts.
   */
  runtime?: boolean
  /** Sends stream_options.include_usage: OpenAI-style APIs omit usage on streams unless asked, and spend stays unknown. */
  usageOnStream?: boolean
  /**
   * About how many minutes an unused prompt-cache entry lasts, where the
   * provider says. Only used to decide whether an idle conversation is worth
   * compacting before then (core/idle-compact.ts); absent means unknown.
   */
  cacheMinutes?: number
  /**
   * Send a step's reasoning back as `reasoning_content` on the assistant message that made tool calls.
   * DeepSeek-style thinking models expect it when a turn continues after a tool; the fork does this for
   * Refuseless (#139). Off elsewhere: other providers have not asked for it.
   */
  replayReasoning?: boolean
  /** The usage block carries `cost`, in US dollars, for the request (Experiential Labs does). It is used instead of the price table. */
  reportsCost?: boolean
  /**
   * Ask the API which models this key may call (GET /models) and list those:
   * catalog entries keep their limits and prices, newly listed chat models are
   * added unpriced with this context window. Catalogs lag - Xiaomi's listed
   * v2.5 while keys could only call v2.6.
   */
  liveModels?: { context: number }
  localTools?: boolean
  localThinking?: boolean
  id: string
  label: string
  /**
   * The chat-completions endpoint, for providers that have one.
   *
   * Image, audio and 3D providers do not: they are reached through their own
   * generators, which speak their own shapes. They live in this catalogue
   * anyway, because there should be one list of models rather than a separate
   * hidden one per medium.
   */
  baseUrl?: string
  /**
   * How this provider wants its key presented.
   *
   * Every provider in the catalogue today takes a bearer token, which is why
   * the header was written inline in two files and a third. That made "speaks
   * OpenAI chat-completions" and "takes an Authorization: Bearer" the same
   * assumption, and they are not: Anthropic wants x-api-key and a version
   * header, Google wants its own. Adding one of those should be a line in
   * this catalogue, not an edit to the agent loop.
   */
  auth?: (key: string) => Record<string, string>
  models: Model[]
}

/**
 * The headers that carry the key, defaulting to a bearer token.
 *
 * One place, so the loop, the summariser and the plain chat client cannot
 * drift apart about how a provider is authenticated.
 */
export function authHeaders(provider: Provider, key: string): Record<string, string> {
  return provider.auth ? provider.auth(key) : { authorization: `Bearer ${key}` }
}

/**
 * The reasoning effort to send for this model, or nothing at all.
 *
 * "auto" means the provider decides, which is the honest default - an effort
 * we picked is a guess about a model we did not train. And a model that does
 * not reason gets nothing regardless of the setting: providers reject the
 * whole request over a field they do not know, so a preference must never be
 * able to break a model it was not about.
 */
export function effortFor(model: Model, setting: string): string | undefined {
  return setting !== "auto" && effortLevels(model).includes(setting) ? setting : undefined
}

export { EFFORT_NAMES }

/**
 * The levels this model offers, under its own names. Declared ones as given;
 * otherwise the standard three for a model that takes an effort at all.
 */
export function effortLevels(model: Model): string[] {
  if (model.efforts) return model.efforts
  return (model.effort ?? model.reasoning === true) ? ["low", "medium", "high"] : []
}

/** Declared if it says so, otherwise assumed from whether it reasons at all. */
export const takesEffort = (model: Model): boolean => effortLevels(model).length > 0

/** What a level means on this model, in a few words, for pickers and status lines. */
export function effortHint(model: Model, level: string): string {
  if (level === "auto") return "this model's default" + (model.defaultEffort ? " (" + model.defaultEffort + ")" : "")
  if (level === "none" || level === "off") return "thinking off: fastest and cheapest"
  const levels = effortLevels(model)
  if (level === levels.at(-1)) return "the most this model offers: slowest, costs the most"
  // The first level that thinks at all, then whatever lies between it and the top.
  const thinking = levels.filter((each) => each !== "none" && each !== "off")
  if (level === thinking[0]) return "a little thinking: quick, for simple work"
  if (thinking.includes(level)) return "more thinking: slower, for harder problems"
  return ""
}

/**
 * Why this level cannot be used on this model, or nothing when it can.
 * A level is never translated to a neighbour: "max" on a model without it is
 * refused with the levels it does have, not quietly sent as "high".
 */
export function effortProblem(model: Model, label: string, level: string): string | undefined {
  if (level === "auto") return undefined
  const levels = effortLevels(model)
  if (!levels.length) return `${label} does not take an effort level`
  if (!levels.includes(level)) return `${label} has no "${level}" - its levels are ${levels.join(", ")}`
  return undefined
}

/** Documented in each provider's API reference (2026-10-30). */
const DEEPSEEK_EFFORT = { efforts: ["none", "low", "high", "max"], defaultEffort: "high" }
const ZAI_EFFORT = { efforts: ["none", "minimal", "low", "medium", "high", "xhigh", "max"], defaultEffort: "max" }
/** `claude --effort`, from the installed CLI's help; its default is not documented there. */
const CLAUDE_EFFORT = ["low", "medium", "high", "xhigh", "max"]

/**
 * DeepSeek charges double from 01:00 to 04:00 and 06:00 to 10:00 UTC, Monday
 * to Friday (api-docs.deepseek.com/quick_start/pricing, 2026-11). Its Chinese
 * public holidays are off-peak; those are counted as peak here, which only
 * ever overstates.
 */
const DEEPSEEK_PEAK = { times: 2, hoursUtc: [[1, 4], [6, 10]] as [number, number][] }

/*
 * Prices below are the fallback for a run that cannot reach models.dev; the
 * daily catalog replaces them (applyCatalogPrices). Checked 2026-11-13.
 */
export const PROVIDERS: Record<string, Provider> = {
  deepseek: {
    id: "deepseek",
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com/chat/completions",
    // "Usually within a few hours to a few days" (api-docs.deepseek.com/guides/kv_cache); the short end.
    cacheMinutes: 120,
    models: [
      // Both think unless told not to (DeepSeek's docs); "none" turns it off.
      { id: "deepseek-v4-flash", label: "V4 Flash", reasoning: true, ...DEEPSEEK_EFFORT, contextWindow: 128000, price: { input: 0.15, output: 0.6, cacheRead: 0.003, peak: DEEPSEEK_PEAK }, capabilities: { input: { text: true, image: true } } },
      { id: "deepseek-v4-pro", label: "V4 Pro", reasoning: true, ...DEEPSEEK_EFFORT, contextWindow: 128000, price: { input: 0.66, output: 1.98, cacheRead: 0.022, peak: DEEPSEEK_PEAK } },
      {
        id: "deepseek-v4-flash-vision-exp",
        label: "V4 Flash Vision",
        contextWindow: 128000,
        price: { input: 0.15, output: 0.6, cacheRead: 0.003, peak: DEEPSEEK_PEAK },
        // Declared, and now meant: a model called Vision that could not be
        // shown a picture was the only kind of vision this had.
        capabilities: { input: { text: true, image: true } },
      },
    ],
  },
  zai: {
    id: "zai",
    label: "GLM",
    baseUrl: "https://api.z.ai/api/paas/v4/chat/completions",
    models: [
      // Unpriced, these were never stopped by the spend brake - it only counts what has a price.
      { id: "glm-5.3-flash", label: "5.3 Flash", reasoning: true, ...ZAI_EFFORT, contextWindow: 128000, price: { input: 0.15, output: 0.5, cacheRead: 0.03 }, capabilities: { input: { text: true, image: true } } },
      { id: "glm-5.3", label: "5.3", reasoning: true, ...ZAI_EFFORT, contextWindow: 200000, price: { input: 1.4, output: 4.4, cacheRead: 0.26 } },
      { id: "glm-5.2", label: "5.2", reasoning: true, ...ZAI_EFFORT, contextWindow: 128000, price: { input: 1.4, output: 4.4, cacheRead: 0.26 } },
      { id: "glm-5.1", label: "5.1", reasoning: true, ...ZAI_EFFORT, contextWindow: 128000, price: { input: 1.4, output: 4.4, cacheRead: 0.26 } },
      { id: "glm-5", label: "5", reasoning: true, ...ZAI_EFFORT, contextWindow: 128000, price: { input: 1, output: 3.2, cacheRead: 0.2 } },
      { id: "glm-5-turbo", label: "5 Turbo", reasoning: true, ...ZAI_EFFORT, contextWindow: 128000, price: { input: 1.2, output: 4, cacheRead: 0.24 } },
      { id: "glm-4.7", label: "4.7", reasoning: true, ...ZAI_EFFORT, contextWindow: 128000, price: { input: 0.6, output: 2.2, cacheRead: 0.11 } },
      { id: "glm-4.6", label: "4.6", reasoning: true, ...ZAI_EFFORT, contextWindow: 128000, price: { input: 0.6, output: 2.2, cacheRead: 0.11 } },
    ],
  },
  moonshotai: {
    id: "moonshotai",
    label: "Kimi",
    baseUrl: "https://api.moonshot.ai/v1/chat/completions",
    models: [
      { id: "kimi-k3", label: "K3", contextWindow: 256000, price: { input: 3, output: 15, cacheRead: 0.3 }, capabilities: { input: { text: true, image: true } } },
      { id: "kimi-k2.7-code", label: "K2.7 Code", contextWindow: 256000, price: { input: 0.95, output: 4, cacheRead: 0.19 }, capabilities: { input: { text: true, image: true } } },
      { id: "kimi-k2.7-code-highspeed", label: "K2.7 Code Highspeed", contextWindow: 256000, price: { input: 1.9, output: 8, cacheRead: 0.38 }, capabilities: { input: { text: true, image: true } } },
      { id: "kimi-k2.6", label: "K2.6", contextWindow: 128000, price: { input: 0.95, output: 4, cacheRead: 0.16 }, capabilities: { input: { text: true, image: true } } },
      { id: "kimi-k2.5", label: "K2.5", contextWindow: 128000 },
    ],
  },
  google: {
    id: "google",
    label: "Google",
    models: [
      {
        id: "gemini-2.5-flash-image",
        label: "Gemini 2.5 Flash Image",
        contextWindow: 0,
        capabilities: { input: { text: true, image: true }, output: { image: true } },
      },
    ],
  },
  xai: {
    id: "xai",
    label: "xAI",
    models: [
      {
        id: "grok-imagine-image-quality",
        label: "Grok Imagine (quality)",
        contextWindow: 0,
        capabilities: { input: { text: true, image: true }, output: { image: true } },
      },
      {
        id: "grok-imagine-image",
        label: "Grok Imagine",
        contextWindow: 0,
        capabilities: { input: { text: true, image: true }, output: { image: true } },
      },
      {
        id: "grok-imagine-image-2.0",
        label: "Grok Imagine 2.0",
        contextWindow: 0,
        capabilities: { input: { text: true, image: true }, output: { image: true } },
      },
    ],
  },
  openai: {
    id: "openai",
    label: "OpenAI",
    // Chat and pictures from one key. The image model still goes to its
    // generator - what a prompt becomes is decided by the model's kind.
    baseUrl: "https://api.openai.com/v1/chat/completions",
    // Extended retention "typically keeps entries available for around 30 minutes" (OpenAI's prompt caching guide); it is the default.
    cacheMinutes: 30,
    usageOnStream: true,
    models: [
      { id: "gpt-5.6", label: "GPT-5.6", reasoning: true, contextWindow: 1_050_000, price: { input: 4, output: 20, cacheRead: 0.4 }, capabilities: { input: { text: true, image: true } } },
      { id: "gpt-5.6-terra", label: "GPT-5.6 Terra", reasoning: true, contextWindow: 1_050_000, price: { input: 2, output: 12, cacheRead: 0.2 }, capabilities: { input: { text: true, image: true } } },
      { id: "gpt-5.6-luna", label: "GPT-5.6 Luna", reasoning: true, contextWindow: 1_050_000, price: { input: 0.2, output: 1.2, cacheRead: 0.02 }, capabilities: { input: { text: true, image: true } } },
      { id: "gpt-5.6-sol", label: "GPT-5.6 Sol", reasoning: true, contextWindow: 1_050_000, price: { input: 4, output: 20, cacheRead: 0.4 }, capabilities: { input: { text: true, image: true } } },
      { id: "gpt-6-astra", label: "GPT-6 Astra", reasoning: true, contextWindow: 1_050_000, price: { input: 10, output: 50, cacheRead: 1 }, capabilities: { input: { text: true, image: true } } },
      { id: "gpt-5.5", label: "GPT-5.5", reasoning: true, contextWindow: 1_050_000, price: { input: 5, output: 30, cacheRead: 0.5 }, capabilities: { input: { text: true, image: true } } },
      { id: "gpt-5.4-mini", label: "GPT-5.4 mini", reasoning: true, contextWindow: 400_000, price: { input: 0.75, output: 4.5, cacheRead: 0.075 }, capabilities: { input: { text: true, image: true } } },
      { id: "gpt-5.4-nano", label: "GPT-5.4 nano", reasoning: true, contextWindow: 400_000, price: { input: 0.2, output: 1.25, cacheRead: 0.02 }, capabilities: { input: { text: true, image: true } } },
      {
        id: "gpt-image-1",
        label: "GPT Image 1",
        contextWindow: 0,
        capabilities: { input: { text: true, image: true }, output: { image: true } },
      },
    ],
  },
  // Models, limits and prices from the fork's models.dev catalog (2026-10).
  xiaomi: {
    id: "xiaomi",
    label: "Xiaomi MiMo",
    baseUrl: "https://api.xiaomimimo.com/v1/chat/completions",
    liveModels: { context: 262_144 },
    models: [
      { id: "mimo-v2.5-pro", label: "V2.5 Pro", reasoning: true, effort: false, contextWindow: 1_048_576, price: { input: 0.435, output: 0.87, cacheRead: 0.0036 } },
      { id: "mimo-v2.5", label: "V2.5", reasoning: true, effort: false, contextWindow: 1_048_576, price: { input: 0.14, output: 0.28, cacheRead: 0.0028 }, capabilities: { input: { text: true, image: true } } },
      { id: "mimo-v2.5-pro-ultraspeed", label: "V2.5 Pro Ultraspeed", reasoning: true, effort: false, contextWindow: 1_048_576, price: { input: 1.305, output: 2.61, cacheRead: 0.0108 } },
      { id: "mimo-v2-pro", label: "V2 Pro", reasoning: true, effort: false, contextWindow: 1_048_576, price: { input: 0.435, output: 0.87 } },
      { id: "mimo-v2-flash", label: "V2 Flash", reasoning: true, effort: false, contextWindow: 262_144, price: { input: 0.14, output: 0.28 } },
      { id: "mimo-v2-omni", label: "V2 Omni", reasoning: true, effort: false, contextWindow: 262_144, price: { input: 0.14, output: 0.28 }, capabilities: { input: { text: true, image: true } } },
    ],
  },
  meta: {
    id: "meta",
    label: "Meta Muse Spark",
    baseUrl: "https://api.meta.ai/v1/chat/completions",
    liveModels: { context: 1_048_576 },
    models: [
      { id: "muse-spark-1.3", label: "1.3", reasoning: true, effort: false, contextWindow: 1_048_576, price: { input: 1.25, output: 4.25, cacheRead: 0.15 }, capabilities: { input: { text: true, image: true } } },
      { id: "muse-spark-1.3-contributor", label: "1.3 Contributor", reasoning: true, effort: false, contextWindow: 1_048_576, price: { input: 0.1, output: 0.2, cacheRead: 0.002 }, capabilities: { input: { text: true, image: true } } },
      { id: "muse-spark-1.2", label: "1.2", reasoning: true, effort: false, contextWindow: 1_048_576, price: { input: 1.25, output: 4.25, cacheRead: 0.15 }, capabilities: { input: { text: true, image: true } } },
      { id: "muse-spark-1.2-contributor", label: "1.2 Contributor", reasoning: true, effort: false, contextWindow: 1_048_576, price: { input: 0.1, output: 0.2, cacheRead: 0.002 }, capabilities: { input: { text: true, image: true } } },
    ],
  },
  // Filled from Experiential Labs' live catalog; the last good copy is cached.
  explabs: {
    id: "explabs",
    label: "Experiential Labs",
    baseUrl: "https://api.experientiallabs.ai/v1/chat/completions",
    usageOnStream: true,
    // Its catalog price is one route's; requests are billed by the route taken, which has been over double.
    reportsCost: true,
    models: [],
  },
  // Filled from the public Refuseless catalog, with a built-in copy behind it (core/refuseless.ts).
  refuseless: {
    id: "refuseless",
    label: "Refuseless",
    baseUrl: "https://api.refuseless.com/v1/chat/completions",
    usageOnStream: true,
    replayReasoning: true,
    models: [],
  },
  qwen: {
    id: "qwen",
    label: "Qwen",
    models: [
      {
        id: "wan2.7-image-pro",
        label: "Wan 2.7 Image Pro",
        contextWindow: 0,
        capabilities: { input: { text: true, image: true }, output: { image: true } },
      },
    ],
  },
  tripo: {
    id: "tripo",
    label: "Tripo",
    models: [
      {
        id: "text-to-model",
        label: "Text to 3D",
        contextWindow: 0,
        capabilities: { input: { text: true }, output: { model3d: true } },
      },
      {
        id: "image-to-model",
        label: "Image to 3D",
        contextWindow: 0,
        capabilities: { input: { image: true }, output: { model3d: true } },
      },
    ],
  },
  elevenlabs: {
    id: "elevenlabs",
    label: "ElevenLabs",
    models: [
      {
        id: "eleven_multilingual_v2",
        label: "Multilingual v2",
        contextWindow: 0,
        capabilities: { input: { text: true }, output: { audio: true } },
      },
      {
        id: "eleven_turbo_v2_5",
        label: "Turbo v2.5",
        contextWindow: 0,
        capabilities: { input: { text: true }, output: { audio: true } },
      },
      {
        id: "eleven_flash_v2_5",
        label: "Flash v2.5",
        contextWindow: 0,
        capabilities: { input: { text: true }, output: { audio: true } },
      },
      {
        id: "eleven_v3",
        label: "Eleven v3",
        contextWindow: 0,
        capabilities: { input: { text: true }, output: { audio: true } },
      },
    ],
  },
}

const local = localProvider()
if (local) PROVIDERS.local = local
PROVIDERS.llama = { id: "llama", label: "Local", local: true, runtime: true, auth: () => ({}), models: [] }

/**
 * The installed GGUFs, as models.
 *
 * Read from disk rather than declared: a model dropped into the folder is
 * pickable on the next look, and one deleted stops being offered. The scan is
 * cached for two seconds, so calling this from every lookup costs nothing.
 */
export function refreshLocalModels() {
  const provider = PROVIDERS.llama
  if (!provider) return
  const prefs = readPrefs()
  provider.models = installedModels().map((file) => ({
    id: file.id,
    label: `${file.id} · ${(file.sizeBytes / 1024 ** 3).toFixed(1)} GB · ${toolsFor(file, prefs).on ? "tools" : "chat only"}`,
    contextWindow: contextFor(file, prefs),
    price: { input: 0, output: 0 },
  }))
}
refreshLocalModels()

PROVIDERS.explabs!.models = cachedExperientialModels()
let experientialRefresh: Promise<number> | undefined
/**
 * Experiential Labs' current models from its public catalog, once per run.
 * The surfaces start it without waiting; a failure keeps the cached list.
 */
export function refreshExperientialModels(fetcher?: typeof fetch): Promise<number> {
  experientialRefresh ??= fetchExperientialModels(fetcher)
    .then((models) => { PROVIDERS.explabs!.models = models; return models.length })
    .catch(() => PROVIDERS.explabs!.models.length)
  return experientialRefresh
}

PROVIDERS.refuseless!.models = cachedRefuselessModels()
let refuselessRefresh: Promise<number> | undefined
/** The current Refuseless models from its public catalog, once per run. A failure keeps the list already shown. */
export function refreshRefuselessModels(fetcher?: typeof fetch): Promise<number> {
  refuselessRefresh ??= fetchRefuselessModels(fetcher)
    .then((models) => { PROVIDERS.refuseless!.models = models; return models.length })
    .catch(() => PROVIDERS.refuseless!.models.length)
  return refuselessRefresh
}

/** Listed by /models but not chat: speech, images, transcription, embeddings. */
const NOT_CHAT = /(asr|tts|voice|transcribe|whisper|embed|image|dall-e|sam-\d|moderation|realtime|audio)/i

/**
 * The models a provider's key may actually call, for providers marked liveModels.
 * A key with no access, a refused request or an empty answer keeps the catalog.
 */
export async function discoverModels(provider: Provider, key: string, fetcher: typeof fetch = fetch): Promise<boolean> {
  if (!provider.liveModels || !provider.baseUrl || !key) return false
  try {
    const response = await fetcher(provider.baseUrl.replace(/\/chat\/completions$/, "/models"), {
      headers: authHeaders(provider, key), signal: AbortSignal.timeout(10_000), redirect: "error",
    })
    if (!response.ok) return false
    const body = await response.json() as { data?: { id?: unknown }[] }
    const listed = (body.data ?? []).map((entry) => entry.id).filter((id): id is string => typeof id === "string" && /^[A-Za-z0-9._:/-]{1,160}$/.test(id) && !NOT_CHAT.test(id))
    if (!listed.length) return false
    const known = new Map(provider.models.map((model) => [model.id, model]))
    provider.models = listed.map((id) => known.get(id) ?? { id, label: id, contextWindow: provider.liveModels!.context })
      .sort((a, b) => Number(Boolean(b.price)) - Number(Boolean(a.price)) || a.id.localeCompare(b.id))
    return true
  } catch { return false }
}

/** models.dev providers, loaded once per run; the ones with a key join PROVIDERS. */
let catalog: CatalogProvider[] = []
let catalogLoad: Promise<void> | undefined

/**
 * Loads the models.dev catalog (cached for a day), offers every provider in it
 * to /connect, and adds the ones that have a key to the picker. Never holds up
 * startup; a catalog that cannot be had leaves the built-ins as they are.
 */
export function refreshCatalog(keyFor: (id: string) => string | undefined, load: () => Promise<CatalogProvider[]> = loadCatalog): Promise<void> {
  catalogLoad ??= load().then((loaded) => {
    catalog = loaded
    applyCatalogPrices(catalogPrices())
    applyCatalogVision(catalogVision())
    rememberCatalogEnv(loaded)
    for (const entry of loaded) {
      if (PROVIDERS[entry.id] || CONNECTABLE.some((each) => each.id === entry.id)) continue
      CONNECTABLE.push({
        id: entry.id, label: entry.label, about: `${entry.models.length} model${entry.models.length === 1 ? "" : "s"}, from models.dev`,
        ...(FEATURED_CATALOG.includes(entry.id) ? {} : { more: true }),
      })
    }
    activateCatalog(keyFor)
  }).catch(() => {})
  return catalogLoad
}

/**
 * Today's prices for the built-in models, from the catalog.
 *
 * The hand-written table goes stale - DeepSeek's had drifted by half, and two
 * providers had no prices at all, which left the spend brake off for them. A
 * model the catalog does not list keeps what it has; so does a peak schedule,
 * which the catalog cannot express. Returns how many models were repriced.
 */
export function applyCatalogPrices(prices: Record<string, Record<string, Price>>): number {
  let changed = 0
  for (const [providerId, models] of Object.entries(prices)) {
    for (const model of PROVIDERS[providerId]?.models ?? []) {
      const fresh = models[model.id]
      if (!fresh) continue
      model.price = { ...fresh, ...(model.price?.peak ? { peak: model.price.peak } : {}) }
      changed++
    }
  }
  return changed
}

/**
 * Marks the built-in models the catalog says take pictures. It only ever turns vision on: DeepSeek V4 Flash,
 * GLM 5.3 Flash and the Kimi models all take images, and while they were listed as blind a picture attached
 * to them was held back and the model told it could not see. Returns how many models changed.
 */
export function applyCatalogVision(vision: Record<string, string[]>): number {
  let changed = 0
  for (const [providerId, ids] of Object.entries(vision)) {
    for (const model of PROVIDERS[providerId]?.models ?? []) {
      if (!ids.includes(model.id) || model.capabilities?.input?.image || model.capabilities?.output) continue
      model.capabilities = { ...model.capabilities, input: { text: true, ...model.capabilities?.input, image: true } }
      changed++
    }
  }
  return changed
}

/**
 * Adds every catalog provider that now has a key - after /connect stores one, say. Returns the ids added.
 * `connected` names the provider the person has just connected by hand: that is their yes to wherever the
 * catalog places it today, so its remembered address is let go and it is set up again.
 */
export function activateCatalog(keyFor: (id: string) => string | undefined, connected?: string): string[] {
  const added: string[] = []
  if (connected && fromCatalog(connected)) {
    acceptAddress(connected)
    delete PROVIDERS[connected]
  }
  for (const entry of catalog) {
    if (PROVIDERS[entry.id] || !keyFor(entry.id)) continue
    PROVIDERS[entry.id] = asProvider(entry)
    added.push(entry.id)
  }
  return added
}

/**
 * What /connect lists for a query: everything that matches when something is
 * typed; otherwise the built-ins, the featured catalog providers and anything
 * already connected, then one row saying how many more a search would find.
 */
export function connectChoices(query: string, connected: (id: string) => boolean): { id: string; label: string; about: string; connected: boolean }[] {
  const q = query.trim().toLowerCase()
  const rows = CONNECTABLE.map((entry) => ({ ...entry, connected: connected(entry.id) }))
  if (q) return rows.filter((entry) => entry.id.toLowerCase().includes(q) || entry.label.toLowerCase().includes(q) || entry.about.toLowerCase().includes(q))
  const shown = rows.filter((entry) => !entry.more || entry.connected)
  const hidden = rows.length - shown.length
  return hidden ? [...shown, { id: "", label: `… ${hidden} more provider${hidden === 1 ? "" : "s"}`, about: "type part of a name to find one", connected: false }] : shown
}

/** Whether a provider came from models.dev rather than the hand-written catalogue. */
export function fromCatalog(id: string): boolean {
  return catalog.some((entry) => entry.id === id) && !BUILT_IN_IDS.has(id)
}

let liveRefresh: Promise<void> | undefined
/** Discovery for every provider that has a key here, once per run, without holding up startup. */
export function refreshLiveModels(keyFor: (id: string) => string | undefined): Promise<void> {
  liveRefresh ??= Promise.all(Object.values(PROVIDERS).filter((provider) => provider.liveModels).map((provider) => {
    const key = keyFor(provider.id)
    return key ? discoverModels(provider, key) : false
  })).then(() => {})
  return liveRefresh
}

PROVIDERS["claude-code"] = {
  id: "claude-code", label: "Claude CLI (CG tools)", cli: "claude-code",
  // Aliases resolve inside the CLI; its effective context window is not reported here.
  models: ["default", "haiku", "sonnet", "opus"].map((id) => ({ id, label: id, contextWindow: 0, reasoning: id !== "haiku", efforts: id === "haiku" ? [] : CLAUDE_EFFORT })),
}
PROVIDERS.codex = {
  id: "codex", label: "Codex CLI (CG tools)", cli: "codex",
  models: [{ id: "default", label: "official default", contextWindow: 0, effort: true, reasoning: true }],
}
for (const id of ["cursor", "cursor-api"] as const) PROVIDERS[id] = {
  id, label: id === "cursor" ? "Cursor user plan (CG tools)" : "Cursor API key (CG tools)", cli: id,
  models: [{ id: "default", label: "Auto (official selection)", contextWindow: 0, effort: false }],
}

/** The hand-written providers, before any catalog entry joins. */
const BUILT_IN_IDS = new Set(Object.keys(PROVIDERS))

export const DEFAULT_PROVIDER = "deepseek"

export type Selection = { provider: Provider; model: Model }

export function defaultSelection(): Selection {
  const provider = PROVIDERS[DEFAULT_PROVIDER]!
  return { provider, model: provider.models[0]! }
}

/** Where a bare provider id lands: its first chat model, never a generator. */
function firstUsable(provider: Provider): Model | undefined {
  return provider.models.find((model) => kindOf(model) === "text") ?? provider.models[0]
}

/** Accepts "zai", "glm-5.3", or "zai/glm-5.3". */
export function resolveSelection(input?: string): Selection | undefined {
  if (!input) return defaultSelection()
  refreshLocalModels()
  const slash = input.indexOf("/")
  const [head, tail] = slash >= 0 ? [input.slice(0, slash), input.slice(slash + 1)] : [input, undefined]

  const byProvider = PROVIDERS[head!]
  if (byProvider) {
    const model = tail ? byProvider.models.find((m) => m.id === tail) : firstUsable(byProvider)
    return model ? { provider: byProvider, model } : undefined
  }

  for (const provider of Object.values(PROVIDERS)) {
    const model = provider.models.find((m) => m.id === input)
    if (model) return { provider, model }
  }
  return undefined
}

/**
 * What a model produces.
 *
 * A model with no capabilities is a chat model - every text provider in this
 * catalogue predates the field and none of them needed it.
 */
/**
 * Exactly the model named, or nothing.
 *
 * resolveSelection is forgiving on purpose: nothing at all picks the default,
 * and a bare provider id picks one of that provider's models. That is right
 * for starting a conversation and wrong anywhere a choice has to land on one
 * specific model - a setting saved against "whichever model the default happens
 * to be" is a setting nobody chose.
 */
export function exactSelection(named: string | undefined): Selection | undefined {
  const id = typeof named === "string" ? named.trim() : ""
  if (!id) return undefined
  const resolved = resolveSelection(id)
  return resolved && resolved.provider.id + "/" + resolved.model.id === id ? resolved : undefined
}

export type ModelKind = "text" | "image" | "audio" | "model3d"

export function kindOf(model: Model): ModelKind {
  const output = model.capabilities?.output
  if (!output) return "text"
  if (output.model3d) return "model3d"
  if (output.image) return "image"
  if (output.audio) return "audio"
  return "text"
}

/** Only a chat model can answer a question, and only it has somewhere to send one. */
export function isChatModel(selection: Selection): boolean {
  return kindOf(selection.model) === "text" && Boolean(selection.provider.baseUrl || selection.provider.cli || selection.provider.runtime)
}

/**
 * Whether a picture can be attached to a message sent to this model.
 *
 * Chat models only, and deliberately. input.image already means something
 * else on the generators - an image model or a 3D model takes a reference
 * picture and answers with a picture or a mesh - so reading the flag alone
 * would call every one of those a vision model. A vision model is the other
 * direction: a picture goes in and words come out.
 */
export function acceptsImages(selection: Selection): boolean {
  return isChatModel(selection) && selection.model.capabilities?.input?.image === true
}

/**
 * The section a model belongs to, and the order the sections come in.
 *
 * The original guesses these from the model id with regexes, because its
 * catalogue arrives from a server that does not say what a model can do.
 * Ours declares it, so the section is simply read rather than inferred.
 */
export const KIND_LABEL: Record<ModelKind, string> = {
  text: "Text models",
  image: "Image models",
  audio: "Voice & audio models",
  model3d: "3D models",
}

export const KIND_ORDER: ModelKind[] = ["text", "image", "audio", "model3d"]

/** What someone might type after /model to narrow the list. */
const KIND_ALIASES: Record<string, ModelKind> = {
  text: "text",
  chat: "text",
  image: "image",
  images: "image",
  picture: "image",
  audio: "audio",
  voice: "audio",
  speech: "audio",
  tts: "audio",
  "3d": "model3d",
  model3d: "model3d",
  mesh: "model3d",
}

/**
 * Providers you can connect a key to.
 *
 * The original reaches this from the model picker rather than from a command
 * you have to know the name of, and each line says what the key is for -
 * because "elevenlabs" alone does not tell you it is the one that speaks.
 */
/**
 * The models.dev providers worth showing in /connect before anything is typed:
 * the big general ones and the fast hosts. The other couple of hundred are a
 * search away - typing part of a name finds any of them - so the list a person
 * sees first is short enough to read.
 */
export const FEATURED_CATALOG = ["openrouter", "openai", "google", "groq", "mistral", "xai", "togetherai", "fireworks-ai", "cerebras", "deepinfra", "perplexity"]

/** `more`: a models.dev provider that /connect lists only when searched for. */
export const CONNECTABLE: { id: string; label: string; about: string; more?: boolean }[] = [
  { id: "cursor-api", label: "Cursor API key", about: "SDK access; billed to the key's user or team. Browser user-plan login: /login cursor" },
  { id: "deepseek", label: "DeepSeek", about: "chat and reasoning" },
  { id: "zai", label: "GLM", about: "chat and reasoning" },
  { id: "moonshotai", label: "Kimi", about: "chat, long context" },
  { id: "explabs", label: "Experiential Labs", about: "one key, hundreds of chat models (Claude, DeepSeek, GLM and more)" },
  { id: "refuseless", label: "Refuseless", about: "abliterated GLM and DeepSeek, MiniMax and Kimi; 1M context" },
  { id: "meta", label: "Meta Muse Spark", about: "chat and reasoning, 1M context" },
  { id: "xiaomi", label: "Xiaomi MiMo", about: "chat and reasoning, long context" },
  { id: "google", label: "Google", about: "Gemini image generation" },
  { id: "xai", label: "xAI", about: "Grok Imagine, image generation" },
  { id: "openai", label: "OpenAI", about: "GPT chat (API key, not ChatGPT sign-in) and GPT Image" },
  { id: "qwen", label: "Qwen", about: "Wan image generation" },
  { id: "tripo", label: "Tripo", about: "text and image to 3D" },
  { id: "elevenlabs", label: "ElevenLabs", about: "voice, speech and music" },
]

/** What a provider is called, falling back to the id for one we do not know. */
export function providerLabel(id: string): string {
  return CONNECTABLE.find((entry) => entry.id === id)?.label ?? PROVIDERS[id]?.label ?? id
}

export function kindFromWord(word: string): ModelKind | undefined {
  return KIND_ALIASES[word.trim().toLowerCase()]
}

/**
 * Every model, text first, then the generators, each section together.
 *
 * Local text models close the text section under their own heading: picking
 * one is picking to run it on this machine, which is a different choice from
 * picking a hosted chat model.
 */
export function selectionsByKind(): Selection[] {
  return KIND_ORDER.flatMap((kind) => {
    const rows = selectionsOfKind(kind)
    return kind === "text" ? [...rows.filter((row) => !row.provider.local), ...rows.filter((row) => row.provider.local)] : rows
  })
}

/** The picker heading a model sits under. */
export function pickerSection(selection: Selection): string {
  return selection.provider.local && kindOf(selection.model) === "text" ? "Local models" : KIND_LABEL[kindOf(selection.model)]
}

export function selectionsOfKind(kind: ModelKind): Selection[] {
  return allSelections().filter((selection) => kindOf(selection.model) === kind)
}

export function allSelections(): Selection[] {
  refreshLocalModels()
  return Object.values(PROVIDERS).flatMap((provider) =>
    provider.models.map((model) => ({ provider, model })),
  )
}
export { addressNotices }
