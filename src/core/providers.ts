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
   * US dollars per million tokens, in and out.
   *
   * Absent means unpriced rather than free - a spend of nothing and a spend
   * nobody has told us are different things, and the status line says which.
   */
  price?: { input: number; output: number }
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
export function effortFor(model: Model, setting: string): "low" | "medium" | "high" | undefined {
  if (setting !== "low" && setting !== "medium" && setting !== "high") return undefined
  return takesEffort(model) ? setting : undefined
}

/** Declared if it says so, otherwise assumed from whether it reasons at all. */
export const takesEffort = (model: Model): boolean => model.effort ?? model.reasoning === true

export const PROVIDERS: Record<string, Provider> = {
  deepseek: {
    id: "deepseek",
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com/chat/completions",
    models: [
      { id: "deepseek-v4-flash", label: "V4 Flash", contextWindow: 128000, price: { input: 0.28, output: 0.42 } },
      { id: "deepseek-v4-pro", label: "V4 Pro", reasoning: true, contextWindow: 128000, price: { input: 0.55, output: 2.19 } },
      {
        id: "deepseek-v4-flash-vision-exp",
        label: "V4 Flash Vision",
        contextWindow: 128000,
        price: { input: 0.28, output: 0.42 },
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
    models: [
      {
        id: "gpt-image-1",
        label: "GPT Image 1",
        contextWindow: 0,
        capabilities: { input: { text: true, image: true }, output: { image: true } },
      },
    ],
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

PROVIDERS["claude-code"] = {
  id: "claude-code", label: "Claude CLI (CG tools)", cli: "claude-code",
  // Aliases resolve inside the CLI; its effective context window is not reported here.
  models: ["default", "haiku", "sonnet", "opus"].map((id) => ({ id, label: id, contextWindow: 0, effort: id !== "haiku", reasoning: id !== "haiku" })),
}
PROVIDERS.codex = {
  id: "codex", label: "Codex CLI (CG tools)", cli: "codex",
  models: [{ id: "default", label: "official default", contextWindow: 0, effort: true, reasoning: true }],
}
for (const id of ["cursor", "cursor-api"] as const) PROVIDERS[id] = {
  id, label: id === "cursor" ? "Cursor user plan (CG tools)" : "Cursor API key (CG tools)", cli: id,
  models: [{ id: "default", label: "Auto (official selection)", contextWindow: 0, effort: false }],
}

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
export const CONNECTABLE: { id: string; label: string; about: string }[] = [
  { id: "cursor-api", label: "Cursor API key", about: "SDK access; billed to the key's user or team. Browser user-plan login: /login cursor" },
  { id: "deepseek", label: "DeepSeek", about: "chat and reasoning" },
  { id: "zai", label: "GLM", about: "chat and reasoning" },
  { id: "moonshotai", label: "Kimi", about: "chat, long context" },
  { id: "google", label: "Google", about: "Gemini image generation" },
  { id: "xai", label: "xAI", about: "Grok Imagine, image generation" },
  { id: "openai", label: "OpenAI", about: "GPT Image" },
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
