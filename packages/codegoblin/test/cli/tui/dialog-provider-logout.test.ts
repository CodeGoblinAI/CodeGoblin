import { describe, expect, test } from "bun:test"
import { providerLogoutOptions } from "../../../src/cli/cmd/tui/component/dialog-provider-logout"

describe("provider logout options", () => {
  test("uses provider names, preserves custom ids, and sorts by display name", () => {
    expect(
      providerLogoutOptions(
        ["custom-provider", "anthropic"],
        [
          { id: "anthropic", name: "Anthropic" },
          { id: "openai", name: "OpenAI" },
        ],
      ),
    ).toEqual([
      { title: "Anthropic", value: "anthropic", description: "anthropic" },
      { title: "custom-provider", value: "custom-provider", description: "custom-provider" },
    ])
  })
})
