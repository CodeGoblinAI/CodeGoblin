import { describe, expect, test } from "bun:test"
import { normalizeUsageQuotas, summarizeUsage } from "@codegoblin/core/usage"

describe("usage summary", () => {
  test("sums token classes and zero-cost subscription sessions without fabrication", () => {
    const result = summarizeUsage([
      {
        id: "one",
        cost: 0,
        tokens: { input: 10, output: 4, reasoning: 2, cache: { read: 3, write: 1 } },
      },
      { id: "two", cost: 1.25, tokens: { input: 5, output: 2, reasoning: 0, cache: { read: 0, write: 0 } } },
    ], "one")

    expect(result.session).toEqual({
      tokens: { total: 20, input: 10, output: 4, reasoning: 2, cacheRead: 3, cacheWrite: 1 },
      spend: 0,
    })
    expect(result.aggregate.tokens.total).toBe(27)
    expect(result.aggregate.spend).toBe(1.25)
    expect(result.quotas).toEqual([])
  })
})

test("usage summary > normalizes quota windows and preserves unavailable providers as empty", () => {
  expect(
    normalizeUsageQuotas([
      {
        providerID: "claude-code",
        checkedAt: "2026-07-20T00:00:00.000Z",
        windows: [
          { label: "5h", usedPercentage: 50, resetsAt: "soon" },
          { label: "week", usedPercentage: 125 },
        ],
      },
      { providerID: "cursor-agent", windows: [] },
    ]),
  ).toEqual([
    {
      providerID: "claude-code",
      label: "claude-code 5h",
      usedPercentage: 50,
      remainingPercentage: 50,
      resetsAt: "soon",
      checkedAt: "2026-07-20T00:00:00.000Z",
    },
    {
      providerID: "claude-code",
      label: "claude-code week",
      usedPercentage: 100,
      remainingPercentage: 0,
      checkedAt: "2026-07-20T00:00:00.000Z",
    },
  ])
})
