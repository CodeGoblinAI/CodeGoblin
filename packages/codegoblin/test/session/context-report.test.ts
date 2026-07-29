import { describe, expect, test } from "bun:test"
import { buildContextReport, format, summarize, type SystemBlock } from "@/session/context-report"

const block = (label: string, stability: SystemBlock["stability"], chars: number): SystemBlock => ({
  label,
  stability,
  text: "x".repeat(chars),
})

describe("buildContextReport", () => {
  test("totals system blocks and tool schemas", () => {
    const report = buildContextReport({
      system: [block("base", "static", 400), block("env", "session", 200)],
      tools: {
        read: { description: "a".repeat(100), inputSchema: {} },
      },
    })

    expect(report.totals.system).toBe(150) // (400 + 200) / 4
    expect(report.totals.tools).toBe(26) // (100 + len("{}")) / 4 rounded
    expect(report.totals.baseline).toBe(report.totals.system + report.totals.tools)
  })

  test("a well-ordered prefix poisons nothing", () => {
    const report = buildContextReport({
      system: [block("base", "static", 4000), block("env", "session", 400)],
    })

    expect(report.ordered).toBe(true)
    expect(report.poisoned).toBe(0)
    expect(report.cacheable).toBe(report.totals.system)
    expect(report.breakpoint).toBe(1)
  })

  test("a turn-volatile block poisons everything after it", () => {
    const report = buildContextReport({
      system: [
        block("memory", "turn", 400), // regenerated every request
        block("base", "static", 8000),
        block("env", "session", 400),
      ],
    })

    // Nothing before the volatile block, so the whole prefix is unusable.
    expect(report.cacheable).toBe(0)
    expect(report.poisoned).toBe(report.totals.system)
    expect(report.ordered).toBe(false)
    expect(report.breakpoint).toBe(-1)
  })

  test("moving the volatile block last recovers the prefix", () => {
    const before = buildContextReport({
      system: [block("memory", "turn", 400), block("base", "static", 8000)],
    })
    const after = buildContextReport({
      system: [block("base", "static", 8000), block("memory", "turn", 400)],
    })

    expect(before.cacheable).toBe(0)
    expect(after.cacheable).toBe(2000)
    expect(after.poisoned).toBe(100)
    expect(after.ordered).toBe(true)
    expect(after.breakpoint).toBe(0)
  })

  test("orders tools by cost so the worst offenders are obvious", () => {
    const report = buildContextReport({
      system: [],
      tools: {
        small: { description: "a".repeat(40) },
        huge: { description: "a".repeat(4000) },
        medium: { description: "a".repeat(400) },
      },
    })

    expect(report.tools.map((t) => t.name)).toEqual(["huge", "medium", "small"])
  })

  test("survives non-serialisable tool schemas", () => {
    const circular: Record<string, unknown> = { description: "x".repeat(40) }
    circular["inputSchema"] = circular

    const report = buildContextReport({ system: [], tools: { circular } })
    expect(report.tools[0].tokens).toBe(10)
  })

  test("handles an empty request", () => {
    const report = buildContextReport({ system: [] })
    expect(report.totals.baseline).toBe(0)
    expect(report.ordered).toBe(true)
    expect(report.poisoned).toBe(0)
  })
})

describe("summarize", () => {
  test("exposes the numbers the debug log needs", () => {
    const report = buildContextReport({
      system: [block("base", "static", 400), block("memory", "turn", 400)],
    })
    expect(summarize(report)).toEqual({
      baseline: 200,
      system: 200,
      tools: 0,
      cacheable: 100,
      poisoned: 100,
      ordered: true,
    })
  })
})

describe("format", () => {
  test("renders blocks, tools and the cache verdict", () => {
    const output = format(
      buildContextReport({
        system: [block("base prompt", "static", 400), block("memory", "turn", 400)],
        tools: { read: { description: "a".repeat(100) } },
      }),
    )

    expect(output).toContain("base prompt")
    expect(output).toContain("memory")
    expect(output).toContain("read")
    expect(output).toContain("cacheable prefix")
    expect(output).toContain("poisoned by turn-volatile blocks (50%)")
  })

  test("flags an out-of-order prefix", () => {
    const output = format(
      buildContextReport({
        system: [block("memory", "turn", 400), block("base", "static", 400)],
      }),
    )
    expect(output).toContain("ordered static -> session -> turn")
    expect(output).toContain("NO")
  })
})
