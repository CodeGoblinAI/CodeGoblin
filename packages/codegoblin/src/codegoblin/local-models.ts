/**
 * Discovery for local model runtimes (Ollama, LM Studio).
 *
 * These run as local HTTP servers exposing their catalogs, so detection is a short, timed probe.
 * Kept separate from the core runtime status so it never blocks hot paths (TUI hub, health).
 */

export type LocalModelRuntimeID = "ollama" | "lmstudio"

export type LocalModelRuntime = {
  id: LocalModelRuntimeID
  name: string
  baseURL: string
  available: boolean
  models: string[]
}

export type DiscoverLocalModelsOptions = {
  /** Injectable for tests; defaults to global fetch. */
  fetchFn?: typeof fetch
  env?: Record<string, string | undefined>
  ollamaURL?: string
  lmStudioURL?: string
  /** Per-runtime probe timeout. Short so `cg status` stays snappy when nothing is running. */
  timeoutMs?: number
}

const DEFAULT_OLLAMA = "http://127.0.0.1:11434"
const DEFAULT_LMSTUDIO = "http://127.0.0.1:1234"

function normalizeBaseURL(value: string | undefined, fallback: string): string {
  const raw = (value ?? "").trim() || fallback
  const withProtocol = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`
  return withProtocol.replace(/\/+$/, "")
}

export function ollamaBaseURL(env: Record<string, string | undefined> = process.env): string {
  return normalizeBaseURL(env.CODEGOBLIN_OLLAMA_URL || env.OLLAMA_HOST, DEFAULT_OLLAMA)
}

export function lmStudioBaseURL(env: Record<string, string | undefined> = process.env): string {
  return normalizeBaseURL(env.CODEGOBLIN_LMSTUDIO_URL || env.LMSTUDIO_BASE_URL, DEFAULT_LMSTUDIO)
}

function extractOllamaModels(data: unknown): string[] {
  const models = (data as { models?: unknown })?.models
  if (!Array.isArray(models)) return []
  return models.map((m) => (m as { name?: unknown })?.name).filter((n): n is string => typeof n === "string")
}

function extractOpenAIModels(data: unknown): string[] {
  const list = (data as { data?: unknown })?.data
  if (!Array.isArray(list)) return []
  return list.map((m) => (m as { id?: unknown })?.id).filter((id): id is string => typeof id === "string")
}

async function probe(
  id: LocalModelRuntimeID,
  name: string,
  baseURL: string,
  endpoint: string,
  extract: (data: unknown) => string[],
  fetchFn: typeof fetch,
  timeoutMs: number,
): Promise<LocalModelRuntime> {
  const offline: LocalModelRuntime = { id, name, baseURL, available: false, models: [] }
  try {
    const response = await fetchFn(`${baseURL}${endpoint}`, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: "application/json" },
    })
    if (!response.ok) return offline
    const data = await response.json().catch(() => undefined)
    return { id, name, baseURL, available: true, models: extract(data) }
  } catch {
    return offline
  }
}

export async function discoverLocalModels(options: DiscoverLocalModelsOptions = {}): Promise<LocalModelRuntime[]> {
  const fetchFn = options.fetchFn ?? fetch
  const env = options.env ?? process.env
  const timeoutMs = options.timeoutMs ?? 700
  const ollama = options.ollamaURL ? normalizeBaseURL(options.ollamaURL, DEFAULT_OLLAMA) : ollamaBaseURL(env)
  const lmStudio = options.lmStudioURL ? normalizeBaseURL(options.lmStudioURL, DEFAULT_LMSTUDIO) : lmStudioBaseURL(env)
  return Promise.all([
    probe("ollama", "Ollama", ollama, "/api/tags", extractOllamaModels, fetchFn, timeoutMs),
    probe("lmstudio", "LM Studio", lmStudio, "/v1/models", extractOpenAIModels, fetchFn, timeoutMs),
  ])
}

export function formatLocalModels(runtimes: LocalModelRuntime[]): string {
  const available = runtimes.filter((runtime) => runtime.available)
  if (available.length === 0) {
    return "Local models: none detected (start Ollama or LM Studio)"
  }
  return available
    .map((runtime) => {
      const count = runtime.models.length
      const preview = runtime.models.slice(0, 3).join(", ")
      const more = count > 3 ? `, +${count - 3} more` : ""
      const list = count ? `${preview}${more}` : "running, no models pulled yet"
      return `Local models (${runtime.id}): ${list} · ${runtime.baseURL}`
    })
    .join("\n")
}
