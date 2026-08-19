import { describe, expect, test } from "bun:test"
import { liveReasoningLabel } from "../../../src/cli/cmd/tui/context/thinking"

describe("liveReasoningLabel", () => {
  test("shows Antigravity progress without claiming hidden reasoning", () => {
    expect(liveReasoningLabel("antigravity-cli", null, "8s")).toBe("Antigravity working · 8s")
    expect(liveReasoningLabel("Antigravity CLI", null, "8s")).toBe("Antigravity working · 8s")
  })

  test("preserves real reasoning titles for other providers", () => {
    expect(liveReasoningLabel("openai", "Checking the workspace", "2s")).toBe(
      "Thinking: Checking the workspace · 2s",
    )
  })
})
