import { describe, expect, test } from "bun:test"
import { antigravityQuotaFrom, parseAntigravityUsage } from "../../src/provider/antigravity-usage"
import { antigravityAgentCandidates } from "../../src/provider/cli-agent"

// Captured verbatim from `agy` 1.1.7's interactive /usage panel.
const PANEL = `
GEMINI MODELS
  Models within this group: Gemini Flash, Gemini Pro
  Weekly Limit
    [██████████████████████████████░░░░░░░░░░░░░░░░░░░░] 60.92%
    61% remaining · Refreshes in 40h 21m
  Five Hour Limit
    [████████████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░] 23.57%
    24% remaining · Refreshes in 2h 44m
CLAUDE AND GPT MODELS
  Models within this group: Claude Opus, Claude Sonnet, GPT-OSS
  Weekly Limit
    [██████████████████████████████████████████████████] 100.00%
    Quota available
  Five Hour Limit
    [██████████████████████████████████████████████████] 100.00%
    Quota available
`

describe("antigravity /usage parsing", () => {
  test("reads AGY's percentage as remaining, not consumed", () => {
    // The panel prints "60.92%" alongside "61% remaining" — treating that as
    // usage would invert the meaning and report a nearly-exhausted quota.
    const windows = parseAntigravityUsage(PANEL).filter((w) => w.group.includes("gemini"))
    expect(windows).toEqual([
      { group: "gemini", label: "week", usedPercentage: 39, resetsAt: "40h21m" },
      { group: "gemini", label: "5h", usedPercentage: 76, resetsAt: "2h44m" },
    ])
  })

  test("ignores groups that report no number", () => {
    // "Quota available" with no percentage is not a measurement.
    const claude = parseAntigravityUsage(PANEL).filter((w) => w.group.includes("claude"))
    expect(claude).toEqual([])
  })

  test("builds a quota record for the provider's own model group", () => {
    const quota = antigravityQuotaFrom(PANEL)
    expect(quota?.providerID).toBe("antigravity-cli")
    expect(quota?.windows.map((w) => w.label)).toEqual(["week", "5h"])
    expect(quota?.windows[1]).toEqual({ label: "5h", usedPercentage: 76, resetsAt: "2h44m" })
  })

  test("survives an unrecognised panel instead of inventing numbers", () => {
    expect(antigravityQuotaFrom("no usage here")).toBeUndefined()
    expect(parseAntigravityUsage("")).toEqual([])
  })

  test("tolerates ansi styling around the figures", () => {
    const styled = "GEMINI MODELS\n  Five Hour Limit\n    [32m10% remaining[0m · Refreshes in 1h 5m"
    expect(parseAntigravityUsage(styled)).toEqual([
      { group: "gemini", label: "5h", usedPercentage: 90, resetsAt: "1h5m" },
    ])
  })

  test("reads the current AGY limit-remaining headings", () => {
    const current = `
GEMINI MODELS
  Weekly Limit Remaining
    [███████████████████████████████████████████████░░░] 94.17%
    94% remaining · Refreshes in 89h 36m
  Five Hour Limit Remaining
    [████████████████████████████████████████████████░░] 96.33%
    96% remaining · Refreshes in 1h 10m
`
    expect(parseAntigravityUsage(current)).toEqual([
      { group: "gemini", label: "week", usedPercentage: 6, resetsAt: "89h36m" },
      { group: "gemini", label: "5h", usedPercentage: 4, resetsAt: "1h10m" },
    ])
  })
})

describe("antigravity executable discovery (portability)", () => {
  test("falls back to install locations when PATH lookup misses", () => {
    // Regression: agy had no candidate list, so it silently disappeared from
    // the model picker on machines where `agy` was not on PATH.
    const win = antigravityAgentCandidates({ LOCALAPPDATA: "C:\\Users\\a\\AppData\\Local" }, "win32")
    expect(win.map((p) => p.replace(/\\/g, "/"))).toEqual([
      "C:/Users/a/AppData/Local/agy/bin/agy.exe",
      "C:/Users/a/AppData/Local/agy/bin/agy.cmd",
    ])
    const unix = antigravityAgentCandidates({ HOME: "/home/a" }, "linux")
    expect(unix[0]).toBe("/home/a/.local/bin/agy")
    expect(unix).toContain("/opt/homebrew/bin/agy")
  })

  test("returns nothing rather than guessing when the home dir is unknown", () => {
    expect(antigravityAgentCandidates({}, "linux")).toEqual([])
    expect(antigravityAgentCandidates({}, "win32")).toEqual([])
  })
})
