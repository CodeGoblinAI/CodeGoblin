import { describe, expect, test } from "bun:test"
import { augmentAudioModelCatalog, codeGoblinProviderInfo } from "@/codegoblin/provider"
import type { Info } from "@/provider/provider"

describe("CodeGoblin provider catalog", () => {
  test("exposes Qwen image aliases for model selection", () => {
    const provider = codeGoblinProviderInfo()

    expect(provider.models["qwen-image-pro"]?.capabilities.output.image).toBe(true)
    expect(provider.models["qwen-image-pro"]?.api.id).toBe("wan2.7-image-pro")
    expect(provider.models["qwen-image-edit"]?.capabilities.input.image).toBe(true)
  })

  test("exposes ElevenLabs audio models for testing", () => {
    const provider = codeGoblinProviderInfo()

    expect(provider.models["elevenlabs-tts"]?.capabilities.output.audio).toBe(true)
    expect(provider.models["elevenlabs-music"]?.capabilities.output.audio).toBe(true)
    expect(provider.models["elevenlabs-tts"]?.capabilities.output.text).toBe(false)
  })

  test("adds ElevenLabs to supplemental catalogs for connect menus", () => {
    const catalog: Record<string, Info> = {}

    augmentAudioModelCatalog(catalog)

    expect(catalog.elevenlabs?.name).toBe("ElevenLabs")
    expect(catalog.elevenlabs?.env).toContain("ELEVENLABS_API_KEY")
    expect(catalog.elevenlabs?.models["eleven_multilingual_v2"]?.capabilities.output.audio).toBe(true)
  })
})