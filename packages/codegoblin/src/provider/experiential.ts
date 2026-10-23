import { Option, Schema } from "effect"
import type * as ModelsDev from "@codegoblin/core/models-dev"

const Rate = Schema.optional(Schema.NullOr(Schema.Finite))
const Row = Schema.Struct({
  model: Schema.Struct({
    slug: Schema.String,
    display_name: Schema.String,
    status: Schema.String,
    release_date: Schema.optional(Schema.NullOr(Schema.String)),
    context_window: Schema.NullOr(Schema.Finite),
    max_input_tokens: Rate,
    max_output_tokens: Schema.NullOr(Schema.Finite),
    input_modalities: Schema.Array(Schema.String),
    output_modalities: Schema.Array(Schema.String),
    supported_params: Schema.Struct({
      tools: Schema.optional(Schema.Boolean),
      reasoning: Schema.optional(Schema.Boolean),
      temperature: Schema.optional(Schema.Boolean),
    }),
  }),
  default_provider_ids: Schema.Array(Schema.String),
  providers: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      input_nano_usd_per_million: Rate,
      output_nano_usd_per_million: Rate,
      cached_input_nano_usd_per_million: Rate,
      cache_write_input_nano_usd_per_million: Rate,
      capabilities: Schema.optional(Schema.Struct({ supports_streaming: Schema.optional(Schema.Boolean) })),
    }),
  ),
})
const Page = Schema.Struct({
  models: Schema.Array(Schema.Unknown),
  total: Schema.Finite,
  limit: Schema.Finite,
  offset: Schema.Finite,
})

export function experientialModels(rows: readonly unknown[]): Record<string, ModelsDev.Model> {
  return Object.fromEntries(
    rows.flatMap((raw) => {
      const row = Option.getOrUndefined(Schema.decodeUnknownOption(Row)(raw))
      if (!row) return []
      const model = row.model
      const provider = row.providers.find((item) => item.id === row.default_provider_ids[0])
      if (
        !model.slug ||
        model.status !== "active" ||
        !model.supported_params.tools ||
        !model.input_modalities.includes("text") ||
        !model.output_modalities.includes("text") ||
        !model.context_window ||
        model.context_window <= 0 ||
        !model.max_output_tokens ||
        model.max_output_tokens <= 0 ||
        !provider ||
        provider.capabilities?.supports_streaming === false
      )
        return []
      const input = model.input_modalities.filter((item): item is "text" | "image" | "audio" | "video" | "pdf" =>
        ["text", "image", "audio", "video", "pdf"].includes(item),
      )
      const priced =
        typeof provider.input_nano_usd_per_million === "number" &&
        provider.input_nano_usd_per_million >= 0 &&
        typeof provider.output_nano_usd_per_million === "number" &&
        provider.output_nano_usd_per_million >= 0
      const result: ModelsDev.Model = {
        id: model.slug,
        name: model.display_name,
        release_date: model.release_date ?? "",
        attachment: input.some((item) => item !== "text"),
        reasoning: model.supported_params.reasoning ?? false,
        temperature: model.supported_params.temperature ?? false,
        tool_call: true,
        modalities: { input, output: ["text"] },
        limit: {
          context: model.context_window,
          output: model.max_output_tokens,
          ...(model.max_input_tokens && model.max_input_tokens > 0 ? { input: model.max_input_tokens } : {}),
        },
        // Catalog prices are nano-USD per million tokens, not USD. Promotions
        // depend on the caller's plan and must not be advertised as a free model.
        ...(priced
          ? {
              cost: {
                input: provider.input_nano_usd_per_million! / 1e9,
                output: provider.output_nano_usd_per_million! / 1e9,
                ...(provider.cached_input_nano_usd_per_million != null
                  ? { cache_read: provider.cached_input_nano_usd_per_million / 1e9 }
                  : {}),
                ...(provider.cache_write_input_nano_usd_per_million != null
                  ? { cache_write: provider.cache_write_input_nano_usd_per_million / 1e9 }
                  : {}),
              },
            }
          : {}),
      }
      return [[model.slug, result]]
    }),
  )
}

export async function experientialCatalog(
  fetcher: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> = globalThis.fetch,
): Promise<ModelsDev.Provider> {
  const models: Record<string, ModelsDev.Model> = {}
  for (let offset = 0; offset < 5000; ) {
    const response = await fetcher(
      `https://api.experientiallabs.ai/api/models?sort=preferred&supports=tools&limit=100&offset=${offset}`,
      {
        signal: AbortSignal.timeout(15_000),
        redirect: "error",
      },
    )
    if (!response.ok) throw new Error(`Experiential Labs catalog returned HTTP ${response.status}`)
    const page = Schema.decodeUnknownSync(Page)(await response.json())
    Object.assign(models, experientialModels(page.models))
    if (page.offset !== offset || page.limit <= 0 || !Number.isInteger(page.limit) || !page.models.length) {
      throw new Error("Experiential Labs catalog returned invalid pagination")
    }
    offset += page.limit
    if (offset >= page.total) {
      if (!Object.keys(models).length) throw new Error("Experiential Labs catalog returned no chat models with tools")
      return {
        id: "explabs",
        name: "Experiential Labs",
        env: ["EXPLABS_API_KEY"],
        npm: "@ai-sdk/openai-compatible",
        api: "https://api.experientiallabs.ai/v1",
        models: Object.fromEntries(Object.entries(models).sort(([a], [b]) => a.localeCompare(b))),
      }
    }
  }
  throw new Error("Experiential Labs catalog exceeded the pagination limit")
}
