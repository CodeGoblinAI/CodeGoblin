import { describe, expect, test } from "bun:test"
import { Zen } from "../../src/provider/zen"

describe("Zen request compatibility", () => {
  test("does not interpret the CodeGoblin release as the upstream version", () => {
    const headers = Zen.headers({ providerID: "opencode", version: "0.3.9", sessionID: "ses_example" })
    expect(headers["User-Agent"]).toBe("opencode/1.18.0 codegoblin/0.3.9")
    expect(headers["x-codegoblin-version"]).toBe("0.3.9")
    expect(headers["x-opencode-session-id"]).toBe("ses_example")
    expect(headers).not.toHaveProperty("x-opencode-parent-session-id")
  })

  test("keeps local builds identifiable without changing the compatibility token", () => {
    expect(Zen.headers({ providerID: "opencode", version: "local", sessionID: "ses_example" })["User-Agent"]).toBe(
      "opencode/1.18.0 codegoblin/local",
    )
  })

  test("preserves upstream parent-session routing metadata", () => {
    expect(
      Zen.headers({ providerID: "opencode", version: "0.3.9", sessionID: "ses_child", parentSessionID: "ses_parent" }),
    ).toMatchObject({
      "x-opencode-session-id": "ses_child",
      "x-opencode-parent-session-id": "ses_parent",
    })
  })

  test("does not change headers for other providers, including OpenCode Go", () => {
    for (const providerID of ["openai", "anthropic", "codegoblin", "opencode-go"]) {
      expect(Zen.headers({ providerID, version: "0.3.9", sessionID: "ses_example" })).toEqual({})
    }
  })
})
