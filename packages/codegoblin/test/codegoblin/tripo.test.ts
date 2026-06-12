import { describe, expect, test } from "bun:test"
import { describeTripoFailure, estimateTripoCredits } from "@/codegoblin/model3d-providers/tripo"

describe("estimateTripoCredits", () => {
  test("returns text/image estimates for a known model version", () => {
    expect(estimateTripoCredits("text", "v3.1-20260211")).toBe(20)
    expect(estimateTripoCredits("image", "v3.1-20260211")).toBe(30)
  })

  test("falls back to defaults for an unknown model version", () => {
    expect(estimateTripoCredits("text", "v9.9-unknown")).toBe(20)
    expect(estimateTripoCredits("image", "v9.9-unknown")).toBe(30)
  })
})

describe("describeTripoFailure", () => {
  test("prefers Tripo's own message when present", () => {
    expect(describeTripoFailure("failed", "Insufficient balance")).toBe("Insufficient balance")
    expect(describeTripoFailure("banned", "  blocked content  ")).toBe("blocked content")
  })

  test("explains a banned task", () => {
    expect(describeTripoFailure("banned")).toMatch(/content policy/i)
  })

  test("explains a cancelled task", () => {
    expect(describeTripoFailure("cancelled")).toMatch(/cancelled/i)
  })

  test("hints at exhausted credits on failure", () => {
    expect(describeTripoFailure("failed")).toMatch(/credits/i)
  })

  test("handles unknown and arbitrary statuses", () => {
    expect(describeTripoFailure("unknown")).toMatch(/unknown/i)
    expect(describeTripoFailure("weird")).toBe("Tripo task weird.")
  })
})
