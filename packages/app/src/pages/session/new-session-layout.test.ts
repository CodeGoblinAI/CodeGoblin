import { describe, expect, test } from "bun:test"
import { shouldUseV2NewSessionPage } from "./new-session-layout"

describe("shouldUseV2NewSessionPage", () => {
  test("uses the v2 new-session page on every channel (redesign shipped)", () => {
    expect(shouldUseV2NewSessionPage({ channel: "prod" })).toBe(true)
    expect(shouldUseV2NewSessionPage({ channel: "dev" })).toBe(true)
    expect(shouldUseV2NewSessionPage({})).toBe(true)
  })

  test("active sessions never use the new-session page", () => {
    expect(shouldUseV2NewSessionPage({ channel: "prod", sessionID: "ses_123" })).toBe(false)
    expect(shouldUseV2NewSessionPage({ channel: "dev", sessionID: "ses_123" })).toBe(false)
  })
})
