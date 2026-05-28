import { describe, expect, test } from "bun:test"
import { isChatSelectableModel, modelBucket } from "./model-buckets"

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

  test("does not allow audio-only models as chat selections", () => {
    expect(
      isChatSelectableModel({
        id: "eleven_multilingual_v2",
        family: "elevenlabs",
        capabilities: {
          input: { text: true },
          output: { audio: true },
        },
      }),
    ).toBe(false)
  })
})
