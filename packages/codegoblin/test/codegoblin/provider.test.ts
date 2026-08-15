import { describe, expect, test } from "bun:test"
import { augmentAudioModelCatalog, augmentMuseSparkModelCatalog, codeGoblinProviderInfo } from "@/codegoblin/provider"
import { Provider } from "@/provider/provider"
import type { Info } from "@/provider/provider"

describe("CodeGoblin provider catalog", () => {
  // These assert the SHAPE of the hosted gateway models, which are only listed
  // once a gateway is configured — otherwise they would be selectable models
  // pointing at a closed port. Configure one so the definitions stay covered.
  const withGateway = { CODEGOBLIN_GATEWAY_KEY: "test" } as NodeJS.ProcessEnv

  test("exposes Qwen image aliases for model selection", () => {
    const provider = codeGoblinProviderInfo(withGateway)

    expect(provider.models["qwen-image-pro"]?.capabilities.output.image).toBe(true)
    expect(provider.models["qwen-image-pro"]?.api.id).toBe("wan2.7-image-pro")
    expect(provider.models["qwen-image-edit"]?.capabilities.input.image).toBe(true)
  })

  test("exposes ElevenLabs audio models for testing", () => {
    const provider = codeGoblinProviderInfo(withGateway)

    expect(provider.models["elevenlabs-tts"]?.capabilities.output.audio).toBe(true)
    expect(provider.models["elevenlabs-music"]?.capabilities.output.audio).toBe(true)
    expect(provider.models["elevenlabs-tts"]?.capabilities.output.text).toBe(false)
  })

  test("hides the hosted gateway models when no gateway is configured", () => {
    // Regression: "CodeGoblin Mock Model" and friends were selectable in the
    // normal picker and every turn hung, because the default baseURL is a
    // loopback port nothing listens on.
    expect(Object.keys(codeGoblinProviderInfo({} as NodeJS.ProcessEnv).models)).toEqual([])
  })

  test("adds ElevenLabs to supplemental catalogs for connect menus", () => {
    const catalog: Record<string, Info> = {}

    augmentAudioModelCatalog(catalog)

    expect(catalog.elevenlabs?.name).toBe("ElevenLabs")
    expect(catalog.elevenlabs?.env).toContain("ELEVENLABS_API_KEY")
    expect(catalog.elevenlabs?.models["eleven_multilingual_v2"]?.capabilities.output.audio).toBe(true)
  })

  test("exposes the newly released Muse Spark 1.2 models", () => {
    const catalog: Record<string, Info> = {
      meta: Provider.fromModelsDevProvider({
        id: "meta",
        name: "Meta",
        env: ["META_MODEL_API_KEY"],
        npm: "@ai-sdk/openai",
        api: "https://api.meta.ai/v1",
        models: {
          "muse-spark-1.1": {
            id: "muse-spark-1.1",
            name: "Muse Spark 1.1",
            release_date: "2026-04-08",
            attachment: true,
            reasoning: true,
            temperature: true,
            tool_call: true,
            modalities: { input: ["text", "image"], output: ["text"] },
            limit: { context: 1_000_000, output: 32_000 },
            cost: { input: 1.25, output: 4.25, cache_read: 0.15 },
          },
        },
      }),
      openrouter: Provider.fromModelsDevProvider({
        id: "openrouter",
        name: "OpenRouter",
        env: ["OPENROUTER_API_KEY"],
        npm: "@ai-sdk/openai-compatible",
        api: "https://openrouter.ai/api/v1",
        models: {
          "meta/muse-spark-1.1": {
            id: "meta/muse-spark-1.1",
            name: "Muse Spark 1.1",
            release_date: "2026-04-08",
            attachment: true,
            reasoning: true,
            temperature: true,
            tool_call: true,
            modalities: { input: ["text", "image"], output: ["text"] },
            limit: { context: 1_000_000, output: 32_000 },
            cost: { input: 1.25, output: 4.25, cache_read: 0.15 },
          },
        },
      }),
    }

    augmentMuseSparkModelCatalog(catalog)
    augmentMuseSparkModelCatalog(catalog)

    expect(String(catalog.meta.models["muse-spark-1.2"]?.id)).toBe("muse-spark-1.2")
    expect(catalog.meta.models["muse-spark-1.2"]?.name).toBe("Muse Spark 1.2")
    expect(catalog.meta.models["muse-spark-1.2"]?.api.id).toBe("muse-spark-1.2")
    expect(catalog.meta.models["muse-spark-1.2"]?.api.url).toBe("https://api.meta.ai/v1")
    expect(catalog.meta.models["muse-spark-1.2"]?.cost.input).toBe(1.25)
    expect(String(catalog.openrouter.models["meta/muse-spark-1.2"]?.id)).toBe("meta/muse-spark-1.2")
    expect(catalog.openrouter.models["meta/muse-spark-1.2"]?.name).toBe("Muse Spark 1.2")
    expect(catalog.openrouter.models["meta/muse-spark-1.2"]?.api.id).toBe("meta/muse-spark-1.2")
    expect(catalog.openrouter.models["meta/muse-spark-1.2"]?.api.url).toBe("https://openrouter.ai/api/v1")
  })
})
