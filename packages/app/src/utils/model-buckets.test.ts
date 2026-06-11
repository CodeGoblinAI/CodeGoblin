import { describe, expect, test } from "bun:test"
import { isChatSelectableModel, isDefaultChatModel, modelBucket } from "./model-buckets"

describe("web model buckets", () => {
  test("keeps vision-capable text models out of image generation buckets", () => {
    expect(
      modelBucket({
        id: "kimi-k2-6-thinking",
        name: "Kimi K2.6 Thinking",
        family: "kimi",
        capabilities: {
          input: { text: true, image: true },
          output: { text: true, image: false },
        },
      }),
    ).toBe("Text models")
  })

  test("places actual output-image models in the image bucket", () => {
    expect(
      modelBucket({
        id: "grok-imagine-image-quality",
        family: "grok-imagine",
        capabilities: {
          input: { text: true },
          output: { image: true },
        },
      }),
    ).toBe("Image models")
  })

  test("allows audio-only models as dedicated selections but not chat defaults", () => {
    const model = {
      id: "eleven_multilingual_v2",
      family: "elevenlabs",
      capabilities: {
        input: { text: true },
        output: { audio: true },
      },
    }
    expect(isChatSelectableModel(model)).toBe(true)
    expect(isDefaultChatModel(model)).toBe(false)
    expect(modelBucket(model)).toBe("Voice & audio models")
  })

  test("places Tripo 3D models in the 3D bucket", () => {
    const model = {
      id: "text-to-model",
      family: "tripo-h3",
      capabilities: {
        input: { text: true },
        output: { model3d: true },
      },
    }
    expect(modelBucket(model)).toBe("3D models")
    expect(isChatSelectableModel(model)).toBe(true)
    expect(isDefaultChatModel(model)).toBe(false)
  })

  test("places local GGUF models in the Local models bucket", () => {
    const model = {
      id: "gemma-3n-E2B-it-Q4_K_M",
      name: "gemma-3n-E2B-it-Q4_K_M (local)",
      family: "local",
      capabilities: { input: { text: true }, output: { text: true } },
    }
    expect(modelBucket(model)).toBe("Local models")
    expect(isChatSelectableModel(model)).toBe(true)
    expect(isDefaultChatModel(model)).toBe(true)
  })
})
