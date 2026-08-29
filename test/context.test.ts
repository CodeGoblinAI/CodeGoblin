import { describe, expect, test } from "bun:test"
import {
  estimateTokens, conversationTokens, usage, shouldCompact, planCompaction, applyCompaction,
  addSpend, priceOf, formatSpend,
} from "../src/core/context"
import type { Message } from "../src/core/agent"

const user = (content: string): Message => ({ role: "user", content })
const assistant = (content: string): Message => ({ role: "assistant", content })

describe("token estimation", () => {
  test("scales with length", () => {
    expect(estimateTokens("a".repeat(400))).toBe(100)
  })

  test("counts a whole conversation", () => {
    expect(conversationTokens([user("a".repeat(400)), assistant("b".repeat(400))])).toBeGreaterThan(200)
  })

  test("usage reports a percentage of the window", () => {
    const messages = [user("a".repeat(4000))]
    expect(usage(messages, 10_000).percent).toBeGreaterThan(5)
    expect(usage(messages, 10_000).percent).toBeLessThanOrEqual(100)
  })
})

describe("compaction", () => {
  test("leaves a short conversation alone", () => {
    expect(shouldCompact([user("hello")], 128_000)).toBe(false)
  })

  test("triggers past the threshold", () => {
    const big = [user("x".repeat(4 * 900)), assistant("y".repeat(4 * 900))]
    expect(shouldCompact(big, 2000)).toBe(true)
  })

  test("always keeps the system prompt", () => {
    const messages: Message[] = [
      { role: "system", content: "you are codegoblin" },
      ...Array.from({ length: 20 }, (_, i) => user("message " + i)),
    ]
    const plan = planCompaction(messages, 200)
    expect(plan.system).toHaveLength(1)
    expect(plan.system[0]!.content).toContain("codegoblin")
  })

  // Providers reject a tool result whose originating call has been dropped.
  test("never starts the kept half on an orphaned tool result", () => {
    const messages: Message[] = [
      { role: "system", content: "s" },
      user("do it"),
      { role: "assistant", content: "", tool_calls: [{ id: "1", type: "function", function: { name: "read_file", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "1", content: "x".repeat(2000) },
      assistant("done"),
    ]
    const plan = planCompaction(messages, 100)
    expect(plan.keep[0]?.role).not.toBe("tool")
  })

  test("rebuilds history as system, summary, then recent", () => {
    const rebuilt = applyCompaction([{ role: "system", content: "s" }], "we did things", [assistant("latest")])
    expect(rebuilt[0]!.role).toBe("system")
    expect(rebuilt[1]!.content).toContain("we did things")
    expect(rebuilt[2]!.content).toBe("latest")
  })
})

describe("what a session cost", () => {
  const DOLLAR = String.fromCharCode(36)

  test("adds up across turns", () => {
    let total = { input: 0, output: 0 }
    total = addSpend(total, { input: 100, output: 50, dollars: 0.001 })
    total = addSpend(total, { input: 200, output: 80, dollars: 0.002 })
    expect(total).toEqual({ input: 300, output: 130, dollars: 0.003 })
  })

  test("prices a turn from the model's rate", () => {
    // 1M in at $0.28 and 1M out at $0.42.
    expect(priceOf({ input: 1_000_000, output: 0 }, { input: 0.28, output: 0.42 })).toBeCloseTo(0.28, 6)
    expect(priceOf({ input: 0, output: 1_000_000 }, { input: 0.28, output: 0.42 })).toBeCloseTo(0.42, 6)
  })

  test("an unpriced model has no price, not a price of zero", () => {
    expect(priceOf({ input: 1000, output: 1000 }, undefined)).toBeUndefined()
    // and stays unpriced however many turns are added
    let total = { input: 0, output: 0 }
    total = addSpend(total, { input: 10, output: 10, dollars: undefined })
    expect(total.dollars).toBeUndefined()
  })

  test("shows tokens when nobody has published a price", () => {
    expect(formatSpend({ input: 1200, output: 300 })).toBe("1,500 tok")
    expect(formatSpend({ input: 1200, output: 300 })).not.toContain(DOLLAR)
  })

  test("carries a dollar sign, and four places while it is pennies", () => {
    // The sign has been silently eaten by tooling here before.
    expect(formatSpend({ input: 1, output: 1, dollars: 0.0004 })).toBe(DOLLAR + "0.0004")
    expect(formatSpend({ input: 1, output: 1, dollars: 1.5 })).toBe(DOLLAR + "1.50")
    expect(formatSpend({ input: 0, output: 0, dollars: 0 })).toBe(DOLLAR + "0")
  })

  test("one priced turn among unpriced ones still reports what is known", () => {
    let total = { input: 0, output: 0 }
    total = addSpend(total, { input: 10, output: 10, dollars: undefined })
    total = addSpend(total, { input: 10, output: 10, dollars: 0.002 })
    expect(total.dollars).toBeCloseTo(0.002, 6)
  })
})
