import { describe, expect, test } from "bun:test"
import { isChatSelectableModel, modelBucket, sortModelCategories } from "@/codegoblin/model-bucket"

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

  test("filters audio-only models from chat selection", () => {
    expect(
      isChatSelectableModel({
        family: "elevenlabs",
        capabilities: {
          input: { text: true },
          output: { audio: true },
        },
      }),
    ).toBe(false)
  })

  test("sorts favorites before recents and regular buckets", () => {
    const categories = ["Recent · Image models", "Text models · OpenAI", "Favorites · Text models"].sort(
      sortModelCategories,
    )

    expect(categories).toEqual(["Favorites · Text models", "Recent · Image models", "Text models · OpenAI"])
  })
})
