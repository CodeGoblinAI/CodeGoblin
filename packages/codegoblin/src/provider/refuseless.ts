import { Option, Schema } from "effect"
import type * as ModelsDev from "@codegoblin/core/models-dev"

const Rate = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))
const Pricing = Schema.Struct({
  currency: Schema.Literal("USD"),
  input_per_m: Rate,
  output_per_m: Rate,
  cached_input_per_m: Schema.optional(Rate),
  long_context: Schema.optional(
    Schema.Struct({
      threshold: Schema.Finite.check(Schema.isGreaterThan(0)),
      input_per_m: Rate,
      output_per_m: Rate,
      cached_input_per_m: Schema.optional(Rate),
    }),
  ),
})
const Row = Schema.Struct({
  id: Schema.String,
  context_length: Schema.Finite.check(Schema.isGreaterThan(0)),
  vision: Schema.optional(Schema.Boolean),
  reasoning_efforts: Schema.optional(Schema.Array(Schema.String)),
  pricing: Pricing,
})
const Page = Schema.Struct({ object: Schema.Literal("list"), data: Schema.Array(Schema.Unknown) })

const names: Record<string, string> = {
  "glm-5.3-abliterated": "GLM 5.3 Abliterated",
  "glm-5.3-flash-abliterated": "GLM 5.3 Flash Abliterated",
  "deepseek-v4.1-flash-abliterated": "DeepSeek V4.1 Flash 1017 Abliterated",
  "deepseek-v4.1-flash-fast": "DeepSeek V4.1 Flash 1017",
  "minimax-m3.1-flash": "MiniMax M3.1 Flash",
  "kimi-k3.1-pro": "Kimi K3.1 Pro",
  "deepseek-v4.1-flash-abliterated-free": "DeepSeek V4.1 Flash 1017 Abliterated (free route)",
  "deepseek-v4.1-flash-abliterated-fast": "DeepSeek V4.1 Flash 1017 Abliterated Fast",
}

export function refuselessModels(rows: readonly unknown[]): Record<string, ModelsDev.Model> {
  return Object.fromEntries(
    rows.flatMap((raw) => {
      const row = Option.getOrUndefined(Schema.decodeUnknownOption(Row)(raw))
      if (!row?.id.trim()) return []
      const reasoning = row.reasoning_efforts?.some((effort) => effort !== "off") ?? false
      const model: ModelsDev.Model = {
        id: row.id,
        name: names[row.id] ?? row.id,
        release_date: "",
        attachment: row.vision === true,
        reasoning,
        temperature: true,
        tool_call: true,
        ...(reasoning ? { interleaved: { field: "reasoning_content" } as const } : {}),
        modalities: { input: row.vision ? ["text", "image"] : ["text"], output: ["text"] },
        // The public catalog does not expose max output. Use a conservative
        // client ceiling rather than treating the entire context as output.
        limit: { context: row.context_length, output: Math.min(32768, row.context_length) },
        cost: {
          input: row.pricing.input_per_m,
          output: row.pricing.output_per_m,
          ...(row.pricing.cached_input_per_m !== undefined ? { cache_read: row.pricing.cached_input_per_m } : {}),
          ...(row.pricing.long_context
            ? {
                tiers: [
                  {
                    tier: { type: "context" as const, size: row.pricing.long_context.threshold },
                    input: row.pricing.long_context.input_per_m,
                    output: row.pricing.long_context.output_per_m,
                    ...(row.pricing.long_context.cached_input_per_m !== undefined
                      ? { cache_read: row.pricing.long_context.cached_input_per_m }
                      : {}),
                  },
                ],
              }
            : {}),
        },
      }
      return [[row.id, model]]
    }),
  )
}

export async function refuselessCatalog(
  fetcher: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> = globalThis.fetch,
): Promise<ModelsDev.Provider> {
  const response = await fetcher("https://api.refuseless.com/v1/models", {
    signal: AbortSignal.timeout(15_000),
    redirect: "error",
  })
  if (!response.ok) throw new Error(`Refuseless catalog returned HTTP ${response.status}`)
  const page = Schema.decodeUnknownSync(Page)(await response.json())
  const models = refuselessModels(page.data)
  if (page.data.length && !Object.keys(models).length)
    throw new Error("Refuseless catalog returned no valid priced models")
  return {
    id: "refuseless",
    name: "Refuseless",
    env: ["REFUSELESS_API_KEY"],
    npm: "@ai-sdk/openai-compatible",
    api: "https://api.refuseless.com/v1",
    models: Object.fromEntries(Object.entries(models).sort(([a], [b]) => a.localeCompare(b))),
  }
}
