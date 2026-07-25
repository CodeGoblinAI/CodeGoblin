import { describe, expect, test } from "bun:test"
import { appendToLastUserMessage } from "@/session/prompt"

/**
 * Per-turn content (wall-clock date, query-ranked memory) has to land after the
 * cacheable prefix. Anything that changes between requests but sits inside the
 * system prompt invalidates the whole cache entry, including every conversation
 * message behind it.
 */
describe("appendToLastUserMessage", () => {
  test("promotes a string body to parts and appends", () => {
    const msgs: { role: string; content: unknown }[] = [{ role: "user", content: "hello" }]
    expect(appendToLastUserMessage(msgs, "turn ctx")).toBe(true)
    expect(msgs[0].content).toEqual([
      { type: "text", text: "hello" },
      { type: "text", text: "turn ctx" },
    ])
  })

  test("appends to an existing parts array", () => {
    const msgs: { role: string; content: unknown }[] = [
      { role: "user", content: [{ type: "text", text: "hello" }] },
    ]
    expect(appendToLastUserMessage(msgs, "turn ctx")).toBe(true)
    expect(msgs[0].content).toEqual([
      { type: "text", text: "hello" },
      { type: "text", text: "turn ctx" },
    ])
  })

  test("targets the newest user message, not an earlier one", () => {
    const msgs: { role: string; content: unknown }[] = [
      { role: "user", content: "first" },
      { role: "assistant", content: "reply" },
      { role: "user", content: "second" },
    ]
    appendToLastUserMessage(msgs, "turn ctx")

    // Earlier turns must stay byte-identical or the prefix stops matching.
    expect(msgs[0].content).toBe("first")
    expect(msgs[2].content).toEqual([
      { type: "text", text: "second" },
      { type: "text", text: "turn ctx" },
    ])
  })

  test("skips trailing assistant messages", () => {
    const msgs: { role: string; content: unknown }[] = [
      { role: "user", content: "ask" },
      { role: "assistant", content: "answer" },
    ]
    expect(appendToLastUserMessage(msgs, "turn ctx")).toBe(true)
    expect(msgs[1].content).toBe("answer")
    expect(msgs[0].content).toEqual([
      { type: "text", text: "ask" },
      { type: "text", text: "turn ctx" },
    ])
  })

  test("reports failure when there is no user message to carry it", () => {
    const msgs: { role: string; content: unknown }[] = [{ role: "assistant", content: "answer" }]
    // Caller falls back to the system prompt rather than dropping the content.
    expect(appendToLastUserMessage(msgs, "turn ctx")).toBe(false)
  })

  test("reports failure on an unexpected content shape", () => {
    const msgs: { role: string; content: unknown }[] = [{ role: "user", content: 42 }]
    expect(appendToLastUserMessage(msgs, "turn ctx")).toBe(false)
  })

  test("empty text is a no-op success", () => {
    const msgs: { role: string; content: unknown }[] = [{ role: "user", content: "hello" }]
    expect(appendToLastUserMessage(msgs, "")).toBe(true)
    expect(msgs[0].content).toBe("hello")
  })

  test("is idempotent across turns for prior messages", () => {
    // Simulates two consecutive requests: the older user message must come out
    // of the second build unchanged, which is what lets the prefix cache hit.
    const turnOne: { role: string; content: unknown }[] = [{ role: "user", content: "u1" }]
    appendToLastUserMessage(turnOne, "ctx1")

    const turnTwo: { role: string; content: unknown }[] = [
      { role: "user", content: "u1" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "u2" },
    ]
    appendToLastUserMessage(turnTwo, "ctx2")
    expect(turnTwo[0].content).toBe("u1")
  })
})
