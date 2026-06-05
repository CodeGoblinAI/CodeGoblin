import { describe, expect, test } from "bun:test"
import { isChatSelectableModel, isDefaultChatModel, modelBucket, sortModelCategories } from "@/codegoblin/model-bucket"

describe("CodeGoblin model buckets", () => {
  test("keeps vision-capable text models in text buckets", () => {
    expect(
      modelBucket("kimi-k2-6-thinking", {
        name: "Kimi K2.6 Thinking",
        family: "kimi",
        capabilities: {
          input: { text: true, image: true },
          output: { text: true, image: false },
        },
      }),
    ).toBe("Text models")
  })

  test("recognizes actual image output models", () => {
    expect(
      modelBucket("gpt-image-1", {
        family: "gpt-image",
        capabilities: {
          input: { text: true, image: true },
          output: { image: true },
        },
      }),
    ).toBe("Image models")
  })

  test("allows audio-only models as dedicated selections but not chat defaults", () => {
    const model = {
      family: "elevenlabs",
      capabilities: {
        input: { text: true },
        output: { audio: true },
      },
    }
    expect(isChatSelectableModel(model)).toBe(true)
    expect(isDefaultChatModel(model)).toBe(false)
  })

  test("places 3D-only models in the 3D bucket", () => {
    const model = {
      family: "tripo-h3",
      capabilities: {
        input: { text: true, image: true },
        output: { model3d: true },
      },
    }
    expect(modelBucket("text-to-model", model)).toBe("3D models")
    expect(isChatSelectableModel(model)).toBe(true)
    expect(isDefaultChatModel(model)).toBe(false)
  })

  test("sorts favorites before recents and regular buckets", () => {
    const categories = ["Recent · Image models", "Text models · OpenAI", "Favorites · Text models"].sort(
      sortModelCategories,
    )

    expect(categories).toEqual(["Favorites · Text models", "Recent · Image models", "Text models · OpenAI"])
  })
})
