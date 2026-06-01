import { describe, expect, test } from "bun:test"
import {
  codeGoblinCompanionActionVariant,
  codeGoblinCompanionActivity,
  codeGoblinCompanionBurnDelta,
  codeGoblinCompanionMode,
  codeGoblinCompanionVisible,
} from "@/codegoblin/companion"

describe("CodeGoblin companion runtime", () => {
  test("shows the real companion by default and keeps opt-out available", () => {
    expect(codeGoblinCompanionVisible(undefined)).toBe(true)
    expect(codeGoblinCompanionVisible("off")).toBe(false)
    expect(codeGoblinCompanionVisible("0")).toBe(false)
  })

  test("defaults to companion mode and animation 03", () => {
    expect(codeGoblinCompanionMode(undefined)).toBe("companion")
    expect(codeGoblinCompanionMode("pinned")).toBe("pinned")
    expect(codeGoblinCompanionActionVariant(undefined)).toBe("03")
    expect(codeGoblinCompanionActionVariant("2")).toBe("02")
  })

  test("maps explicit activity states without inventing runtime activity", () => {
    expect(codeGoblinCompanionActivity("thinking")).toBe("thinking")
    expect(codeGoblinCompanionActivity("image-progress")).toBe("image")
    expect(codeGoblinCompanionActivity("audio-progress")).toBe("audio")
    expect(codeGoblinCompanionActivity(undefined)).toBe("idle")
  })

  test("prefers real spend deltas over token deltas", () => {
    expect(
      codeGoblinCompanionBurnDelta({
        previousCost: 0.25,
        currentCost: 0.5,
        previousTokens: 100,
        currentTokens: 200,
      }),
    ).toEqual({ kind: "spend", amount: 0.25 })
  })

  test("uses token deltas when spend stays flat", () => {
    expect(
      codeGoblinCompanionBurnDelta({
        previousCost: 0,
        currentCost: 0,
        previousTokens: 100,
        currentTokens: 348,
      }),
    ).toEqual({ kind: "tokens", amount: 248 })
  })

  test("does not trigger on initial load or non-increasing totals", () => {
    expect(
      codeGoblinCompanionBurnDelta({
        previousCost: undefined,
        currentCost: 1,
        previousTokens: undefined,
        currentTokens: 500,
      }),
    ).toBeUndefined()
    expect(
      codeGoblinCompanionBurnDelta({
        previousCost: 1,
        currentCost: 1,
        previousTokens: 500,
        currentTokens: 500,
      }),
    ).toBeUndefined()
  })
})
