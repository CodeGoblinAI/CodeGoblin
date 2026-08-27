import { describe, expect, test } from "bun:test"
import {
  discoverNativeModelIDs,
  isNativeModelUnavailableError,
  mergeNativeModels,
  parseNativeModelIDs,
  supportsNativeModelDiscovery,
} from "@/provider/model-discovery"
import { Provider } from "@/provider/provider"
import { ProviderID } from "@/provider/schema"

const provider = Provider.fromModelsDevProvider({
  id: "opencode",
  name: "OpenCode Zen",
  env: ["OPENCODE_API_KEY"],
  npm: "@ai-sdk/openai-compatible",
  api: "https://opencode.ai/zen/v1",
  models: {
    current: {
      id: "current",
      name: "Current",
      release_date: "2026-01-01",
      attachment: true,
      reasoning: true,
      temperature: true,
      tool_call: true,
      limit: { context: 128_000, output: 32_000 },
      modalities: { input: ["text"], output: ["text"] },
    },
    stale: {
      id: "stale",
      name: "Stale",
      release_date: "2025-01-01",
      attachment: false,
      reasoning: false,
      temperature: true,
      tool_call: true,
      limit: { context: 64_000, output: 8_000 },
      modalities: { input: ["text"], output: ["text"] },
    },
    "current-fast": {
      id: "current",
      name: "Current Fast",
      release_date: "2026-01-01",
      attachment: true,
      reasoning: true,
      temperature: true,
      tool_call: true,
      limit: { context: 128_000, output: 32_000 },
      modalities: { input: ["text"], output: ["text"] },
    },
  },
})

describe("provider-native model discovery", () => {
  test("discovers Z.AI models through its authenticated OpenAI-compatible endpoint", async () => {
    const zai = structuredClone(provider)
    zai.id = ProviderID.make("zai")
    zai.options.apiKey = "zai-test-key"
    const requests: Request[] = []

    const ids = await discoverNativeModelIDs(zai, async (input, init) => {
      requests.push(new Request(input, init))
      return new Response(JSON.stringify({ data: [{ id: "glm-5.3" }, { id: "glm-5.3-flash" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    })

    expect(supportsNativeModelDiscovery("zai")).toBeTrue()
    expect(supportsNativeModelDiscovery("zai-coding-plan")).toBeTrue()
    expect(supportsNativeModelDiscovery("zhipuai")).toBeTrue()
    expect(ids).toEqual(["glm-5.3", "glm-5.3-flash"])
    expect(requests[0]?.url).toBe("https://api.z.ai/api/paas/v4/models")
    expect(requests[0]?.headers.get("authorization")).toBe("Bearer zai-test-key")
  })

  test("parses OpenAI-compatible and Google model lists", () => {
    expect(parseNativeModelIDs({ data: [{ id: "chat-model" }, { id: "text-embedding-3-small" }] })).toEqual([
      "chat-model",
    ])
    expect(
      parseNativeModelIDs(
        {
          models: [
            { name: "models/gemini-new", supportedGenerationMethods: ["generateContent"] },
            { name: "models/embed", supportedGenerationMethods: ["embedContent"] },
          ],
        },
        "google",
      ),
    ).toEqual(["gemini-new"])
    expect(parseNativeModelIDs([{ id: "together-model" }])).toEqual(["together-model"])
  })

  test("removes stale catalog entries and keeps variants plus configured models", () => {
    const models = mergeNativeModels(provider, ["current", "brand-new"], ["stale"])
    expect(Object.keys(models).sort()).toEqual(["brand-new", "current", "current-fast", "stale"])
    expect(models["brand-new"].api.id).toBe("brand-new")
    expect(models["brand-new"].cost.input).toBe(0)
  })

  test("does not mutate the last-known provider catalog", () => {
    mergeNativeModels(provider, ["current"])
    expect(provider.models.stale).toBeDefined()
  })

  test("quarantines only explicit model availability errors", () => {
    expect(isNativeModelUnavailableError(new Error("Upstream request failed: Model is unavailable."))).toBeTrue()
    expect(isNativeModelUnavailableError({ responseBody: '{"error":{"code":"model_not_found"}}' })).toBeTrue()
    expect(isNativeModelUnavailableError(new Error("Server is overloaded"))).toBeFalse()
    expect(isNativeModelUnavailableError(new Error("Request timed out"))).toBeFalse()
    expect(isNativeModelUnavailableError(new Error("503: Model is temporarily unavailable"))).toBeFalse()
    expect(isNativeModelUnavailableError(new Error("429 model unavailable due to rate limit"))).toBeFalse()
  })

  test("bounds provider-controlled model lists", () => {
    expect(parseNativeModelIDs({ data: Array.from({ length: 5_100 }, (_, index) => ({ id: `model-${index}` })) })).toHaveLength(5_000)
  })
})
