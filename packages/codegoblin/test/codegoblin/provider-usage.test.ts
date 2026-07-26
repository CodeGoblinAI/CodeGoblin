import { describe, expect, test } from "bun:test"
import {
  captureCodexUsageHeaders,
  compactReset,
  getAllProviderUsage,
  getProviderUsage,
  recordProviderUsage,
} from "../../src/codegoblin/provider-usage"

describe("provider usage", () => {
  test("captures codex rate-limit headers into usage windows", () => {
    captureCodexUsageHeaders(
      new Headers({
        "x-codex-primary-used-percent": "78",
        "x-codex-primary-window-minutes": "300",
        "x-codex-primary-reset-after-seconds": "8040",
        "x-codex-secondary-used-percent": "11",
        "x-codex-secondary-window-minutes": "10080",
      }),
    )
    const usage = getProviderUsage().filter((u) => u.provider === "codex")
    expect(usage).toEqual([
      { label: "5h", pct: 78, reset: "2h14m", provider: "codex" },
      { label: "7d", pct: 11, provider: "codex" },
    ])
  })

  test("ignores header sets without a used-percent value", () => {
    recordProviderUsage("noise", [])
    expect(getProviderUsage().some((u) => u.provider === "noise")).toBe(false)
  })

  test("merges Claude Code CLI quota from the bridge", async () => {
    const usage = await getAllProviderUsage([
      {
        providerID: "claude-code",
        checkedAt: "2026-07-24T22:23:23.751Z",
        windows: [
          { label: "5h", usedPercentage: 24 },
          { label: "week", usedPercentage: 50 },
        ],
      },
    ])
    const claude = usage.filter((u) => u.provider === "claude")
    expect(claude).toEqual([
      { label: "5h", pct: 24, provider: "claude" },
      { label: "week", pct: 50, provider: "claude" },
    ])
  })

  describe("reset hints", () => {
    // The CLI emits absolute local times; three of those overflow the widget's
    // one-line header, so they collapse to the same countdown Codex reports.
    // Built with the local-time constructor so the arithmetic holds wherever
    // CI runs (the CLI's times are local to the machine that produced them).
    const now = new Date(2026, 6, 24, 19, 0)

    test("turns an absolute local time into a countdown", () => {
      expect(compactReset("Jul 24, 7:40pm (America/New_York)", now)).toBe("40m")
      expect(compactReset("Jul 27, 9am (America/New_York)", now)).toBe("2d14h")
    })

    test("keeps the clock time when the date cannot be parsed", () => {
      expect(compactReset("sometime around 7:40pm (America/New_York)", now)).toBe("7:40pm")
    })

    test("crosses the year boundary rather than reporting a negative wait", () => {
      const newYearsEve = new Date(2026, 11, 30, 19, 0)
      expect(compactReset("Jan 2, 9am (America/New_York)", newYearsEve)).toBe("2d14h")
    })

    test("says nothing when the reset already passed, instead of inventing a countdown", () => {
      // Stale quota file: this window rolled over two days ago.
      expect(compactReset("Jul 24, 7:40pm (America/New_York)", new Date(2026, 6, 26, 19, 0))).toBeUndefined()
    })

    test("ignores empty hints", () => {
      expect(compactReset(undefined, now)).toBeUndefined()
      expect(compactReset("   ", now)).toBeUndefined()
    })
  })

  test("orders short windows first so a truncated strip keeps the urgent limit", async () => {
    const usage = await getAllProviderUsage([
      {
        providerID: "claude-code",
        checkedAt: "2026-07-24T22:23:23.751Z",
        windows: [
          { label: "week", usedPercentage: 50 },
          { label: "5h", usedPercentage: 24 },
        ],
      },
    ])
    // Codex 5h (captured above) and Claude 5h both precede any weekly window.
    const shortWindows = usage.slice(0, 2).map((u) => u.label)
    expect(shortWindows.every((label) => /^\d+\s*h/i.test(label))).toBe(true)
    expect(usage.at(-1)?.label).toBe("week")
  })

  test("survives a broken quota source instead of blanking the strip", async () => {
    const usage = await getAllProviderUsage(async () => {
      throw new Error("cli-agent-usage.json is corrupt")
    })
    expect(usage.some((u) => u.provider === "codex")).toBe(true)
  })

  test("drops windows whose reset already passed rather than reporting stale percentages", async () => {
    const usage = await getAllProviderUsage([
      {
        providerID: "claude-code",
        checkedAt: "2020-01-01T00:00:00Z",
        windows: [
          { label: "5h", usedPercentage: 24, resetsAt: "Jan 2, 7:40pm (America/New_York)" },
          { label: "week", usedPercentage: 50 },
        ],
      },
    ])
    const claude = usage.filter((u) => u.provider === "claude")
    // The dated window is long expired; the undated one is all we still know.
    expect(claude).toEqual([{ label: "week", pct: 50, provider: "claude" }])
  })

  test("clamps nonsense percentages and skips non-numeric windows", async () => {
    const usage = await getAllProviderUsage([
      {
        providerID: "claude-code",
        checkedAt: "2026-07-24T22:23:23.751Z",
        windows: [
          { label: "5h", usedPercentage: 140 },
          { label: "bogus", usedPercentage: Number.NaN },
        ],
      },
    ])
    const claude = usage.filter((u) => u.provider === "claude")
    expect(claude).toEqual([{ label: "5h", pct: 100, provider: "claude" }])
  })
})
