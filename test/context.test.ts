import { describe, expect, test } from "bun:test"
import {
  estimateTokens, conversationTokens, usage, shouldCompact, planCompaction, applyCompaction,
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
