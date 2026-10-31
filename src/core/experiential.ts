import fs from "node:fs"
import path from "node:path"
import { Global } from "../platform/paths"
import type { Model } from "./providers"

/**
 * Experiential Labs' models, from its public catalog.
 *
 * The router's inventory changes often, so it is read live rather than typed
 * in, and kept on disk so the picker is not empty offline. Only models a
 * coding agent can use are kept: active, text in and out, tool calling, a
 * routable and priced default route. An unpriced route is left out rather
 * than listed as free. Ported from the fork (#126, #127).
 */
const CATALOG = "https://api.experientiallabs.ai/api/models?sort=preferred&limit=100&offset="
const cacheFile = () => path.join(Global.Path.state, "explabs-models.json")

type Route = {
  id?: string; status?: string; routable?: boolean | null
  input_nano_usd_per_million?: number | null; output_nano_usd_per_million?: number | null
  capabilities?: { supports_streaming?: boolean; supports_tools?: boolean; supports_reasoning?: boolean } | null
}
type Row = {
  model?: {
    slug?: string; display_name?: string; status?: string; context_window?: number | null; max_output_tokens?: number | null
    input_modalities?: string[]; output_modalities?: string[]
    supported_params?: { tools?: boolean; reasoning?: boolean } | null
  }
  default_provider_ids?: string[]
  providers?: Route[]
}

export function experientialModels(rows: readonly unknown[]): Model[] {
  return rows.flatMap((raw): Model[] => {
    const row = raw as Row
    const model = row?.model
    const route = row?.providers?.find((item) => item.id === row.default_provider_ids?.[0])
    if (!model?.slug || typeof model.slug !== "string" || !/^[A-Za-z0-9._:/-]{1,160}$/.test(model.slug)) return []
    if (model.status !== "active" || !route) return []
    if (!(model.supported_params?.tools ?? route.capabilities?.supports_tools)) return []
    if (!model.input_modalities?.includes("text") || !model.output_modalities?.includes("text")) return []
    if (!model.context_window || model.context_window <= 0 || !model.max_output_tokens || model.max_output_tokens <= 0) return []
    if ((route.status !== undefined && route.status !== "active") || route.routable === false || route.capabilities?.supports_streaming === false) return []
    const input = route.input_nano_usd_per_million, output = route.output_nano_usd_per_million
    if (typeof input !== "number" || input < 0 || typeof output !== "number" || output < 0) return []
    const reasoning = model.supported_params?.reasoning ?? route.capabilities?.supports_reasoning ?? false
    return [{
      id: model.slug,
      label: String(model.display_name || model.slug).slice(0, 80),
      contextWindow: model.context_window,
      // Catalog prices are nano-USD per million tokens.
      price: { input: input / 1e9, output: output / 1e9 },
      ...(reasoning ? { reasoning: true, effort: false } : {}),
      ...(model.input_modalities.includes("image") ? { capabilities: { input: { text: true, image: true } } } : {}),
    }]
  }).sort((a, b) => a.id.localeCompare(b.id))
}

export function cachedExperientialModels(): Model[] {
  try {
    const saved = JSON.parse(fs.readFileSync(cacheFile(), "utf8")) as { models?: Model[] }
    return Array.isArray(saved.models) ? saved.models.filter((model) => typeof model?.id === "string" && typeof model.contextWindow === "number") : []
  } catch { return [] }
}

/** Every page of the public catalog, filtered. No key is sent: the catalog is public. */
export async function fetchExperientialModels(fetcher: typeof fetch = fetch): Promise<Model[]> {
  const rows: unknown[] = []
  for (let offset = 0; offset < 5000;) {
    const response = await fetcher(CATALOG + offset, { signal: AbortSignal.timeout(15_000), redirect: "error" })
    if (!response.ok) throw new Error("Experiential Labs catalog returned HTTP " + response.status)
    const page = await response.json() as { models?: unknown[]; total?: number; limit?: number; offset?: number }
    if (!Array.isArray(page.models) || page.offset !== offset || !Number.isInteger(page.limit) || page.limit! <= 0 || typeof page.total !== "number") {
      throw new Error("Experiential Labs catalog returned an unexpected page")
    }
    rows.push(...page.models)
    offset += page.limit!
    if (offset >= page.total || !page.models.length) break
  }
  const models = experientialModels(rows)
  if (!models.length) throw new Error("Experiential Labs catalog listed no chat models with tools")
  try {
    fs.mkdirSync(path.dirname(cacheFile()), { recursive: true })
    fs.writeFileSync(cacheFile(), JSON.stringify({ checkedAt: Date.now(), models }))
  } catch {}
  return models
}
