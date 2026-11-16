import fs from "node:fs"
import path from "node:path"
import { Global } from "../platform/paths"
import type { Model } from "./providers"

/**
 * The models Refuseless serves, from its public catalog (api.refuseless.com/v1/models).
 *
 * Ported from the fork (#139). The built-in list below is that catalog as of
 * 2026-11-14 and is what shows when the catalog cannot be read - it answered
 * 403 to requests without a browser from this machine - so the provider works
 * either way; a successful read replaces it and is kept on disk.
 *
 * Two things the catalog says that the standard assumptions get wrong:
 * the effort levels are low/high/max (plus "off" on most DeepSeek routes), and
 * "medium" is rejected; and the route whose id ends in "-free" is priced.
 */
const CATALOG = "https://api.refuseless.com/v1/models"
const cacheFile = () => path.join(Global.Path.state, "refuseless-models.json")

const NAMES: Record<string, string> = {
  "glm-5.3-abliterated": "GLM 5.3 Abliterated",
  "glm-5.3-flash-abliterated": "GLM 5.3 Flash Abliterated",
  "deepseek-v4.1-flash-abliterated": "DeepSeek V4.1 Flash 1017 Abliterated",
  "deepseek-v4.1-flash-fast": "DeepSeek V4.1 Flash 1017",
  "minimax-m3.1-flash": "MiniMax M3.1 Flash",
  "kimi-k3.1-pro": "Kimi K3.1 Pro",
  "deepseek-v4.1-flash-abliterated-free": "DeepSeek V4.1 Flash 1017 Abliterated (free route)",
  "deepseek-v4.1-flash-abliterated-fast": "DeepSeek V4.1 Flash 1017 Abliterated Fast",
}

type Row = {
  id?: unknown; context_length?: unknown; vision?: unknown; reasoning_efforts?: unknown; reasoning_default?: unknown
  pricing?: { currency?: unknown; input_per_m?: unknown; output_per_m?: unknown; cached_input_per_m?: unknown }
}
const rate = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0

/** Catalog rows as models. A row without an id, a context size or a USD price is left out rather than guessed at. */
export function refuselessModels(rows: readonly unknown[]): Model[] {
  return rows.flatMap((raw): Model[] => {
    const row = (raw ?? {}) as Row
    if (typeof row.id !== "string" || !/^[A-Za-z0-9._:/-]{1,160}$/.test(row.id)) return []
    if (typeof row.context_length !== "number" || !(row.context_length > 0)) return []
    const pricing = row.pricing
    if (!pricing || pricing.currency !== "USD" || !rate(pricing.input_per_m) || !rate(pricing.output_per_m)) return []
    // "off" is the catalog's word and is sent as it is; a model whose only level is "off" does not reason.
    const efforts = Array.isArray(row.reasoning_efforts) ? row.reasoning_efforts.filter((level): level is string => typeof level === "string" && /^[a-z]{1,12}$/.test(level)) : []
    const reasoning = efforts.some((level) => level !== "off")
    return [{
      id: row.id,
      label: NAMES[row.id] ?? row.id,
      contextWindow: row.context_length,
      price: { input: pricing.input_per_m, output: pricing.output_per_m, ...(rate(pricing.cached_input_per_m) ? { cacheRead: pricing.cached_input_per_m } : {}) },
      ...(reasoning ? { reasoning: true, efforts, ...(typeof row.reasoning_default === "string" && efforts.includes(row.reasoning_default) ? { defaultEffort: row.reasoning_default } : {}) } : {}),
      ...(row.vision === true ? { capabilities: { input: { text: true, image: true } } } : {}),
    }]
  }).sort((a, b) => a.id.localeCompare(b.id))
}

const THREE = ["low", "high", "max"]
const FOUR = ["off", "low", "high", "max"]
const row = (id: string, vision: boolean, reasoning_efforts: string[], input_per_m: number, cached_input_per_m: number, output_per_m: number) =>
  ({ id, vision, context_length: 1_048_576, reasoning_efforts, reasoning_default: "low", pricing: { currency: "USD", input_per_m, cached_input_per_m, output_per_m } })
/** The public catalog on 2026-11-14. */
export const REFUSELESS_BUILT_IN: Model[] = refuselessModels([
  row("glm-5.3-abliterated", false, THREE, 1, 0.15, 2),
  row("glm-5.3-flash-abliterated", true, THREE, 0.12, 0.025, 0.5),
  row("deepseek-v4.1-flash-abliterated", true, FOUR, 0.12, 0.019, 0.45),
  row("deepseek-v4.1-flash-fast", true, FOUR, 0.01, 0.002, 0.08),
  row("minimax-m3.1-flash", true, THREE, 0.02, 0.002, 0.08),
  row("kimi-k3.1-pro", true, THREE, 0.25, 0.15, 2.5),
  row("deepseek-v4.1-flash-abliterated-free", true, THREE, 0.12, 0.019, 0.45),
  row("deepseek-v4.1-flash-abliterated-fast", true, FOUR, 0.12, 0.025, 0.45),
])

/** The last catalog read, or the built-in list. */
export function cachedRefuselessModels(): Model[] {
  try {
    const saved = JSON.parse(fs.readFileSync(cacheFile(), "utf8")) as { rows?: unknown[] }
    const models = Array.isArray(saved.rows) ? refuselessModels(saved.rows) : []
    if (models.length) return models
  } catch {}
  return REFUSELESS_BUILT_IN
}

/**
 * The catalog, with its prices. It was public; on 2026-11-16 it answered 403 without a key, so every refresh
 * failed quietly and the prices shown were the ones built in two days earlier. The key is sent when there is
 * one - to this one address, and never along a redirect - and without one the built-in list stands.
 */
export async function fetchRefuselessModels(fetcher: typeof fetch = fetch, key?: string): Promise<Model[]> {
  const response = await fetcher(CATALOG, { signal: AbortSignal.timeout(15_000), redirect: "error", ...(key ? { headers: { authorization: "Bearer " + key } } : {}) })
  if (!response.ok) throw new Error("Refuseless catalog returned HTTP " + response.status)
  const page = await response.json() as { object?: string; data?: unknown[] }
  if (page.object !== "list" || !Array.isArray(page.data)) throw new Error("Refuseless catalog returned an unexpected page")
  const models = refuselessModels(page.data)
  if (!models.length) throw new Error("Refuseless catalog listed no priced models")
  try {
    fs.mkdirSync(path.dirname(cacheFile()), { recursive: true })
    // The rows are kept, not the models, so a later version reads them with its own rules.
    fs.writeFileSync(cacheFile(), JSON.stringify({ checkedAt: Date.now(), rows: page.data }))
  } catch {}
  return models
}
