import { afterEach, describe, expect, test } from "bun:test"
import type { Message } from "../src/core/agent"
import { compactConversation } from "../src/core/agent"
import { idleCompaction, idleKeepWindow, idleNote, MIN_CACHE_MINUTES } from "../src/core/idle-compact"
import { PROVIDERS, type Model, type Provider } from "../src/core/providers"
import { conversationTokens } from "../src/core/context"
import { loadConfig, DEFAULT_IDLE_COMPACT } from "../src/core/config"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

/** A conversation of about `tokens` tokens: a system prompt and alternating turns of ~1,000 tokens each. */
function conversation(tokens: number): Message[] {
  const messages: Message[] = [{ role: "system", content: "You are a helpful goblin." }]
  for (let index = 0; index < Math.round(tokens / 1000); index++) messages.push({ role: index % 2 ? "assistant" : "user", content: ("turn " + index + " ").padEnd(4000, "x") })
  return messages
}
const pricey: Model = { id: "big", label: "Big", contextWindow: 1_000_000, price: { input: 4, output: 20, cacheRead: 0.4 } }
const cheap: Model = { id: "small", label: "Small", contextWindow: 128_000, price: { input: 0.15, output: 0.6, cacheRead: 0.003 } }
const provider = (extra: Partial<Provider> = {}): Provider => ({ id: "test", label: "Test", baseUrl: "https://example.invalid/v1/chat/completions", cacheMinutes: 30, models: [pricey, cheap], ...extra })

describe("whether an idle conversation is worth compacting", () => {
  test("an expensive model with a long conversation: yes, timed inside the cache's life", () => {
    const due = idleCompaction({ messages: conversation(100_000), provider: provider(), model: pricey, min: 0.1 })!
    expect(due).toBeDefined()
    // 100k tokens at $4/M is $0.40 to resend; the summary and the 30k kept cost about half of that.
    expect(due.saving).toBeGreaterThan(0.15)
    expect(due.saving).toBeLessThan(0.3)
    expect(due.keepWindow).toBe(120_000)
  })

  test("a cheap model never is: the saving is cents", () => {
    expect(idleCompaction({ messages: conversation(95_000), provider: provider(), model: cheap, min: 0.1 })).toBeUndefined()
    // ...unless the person sets the bar that low.
    expect(idleCompaction({ messages: conversation(95_000), provider: provider(), model: cheap, min: 0.005 })).toBeDefined()
  })

  test("not without a cache worth waiting on, a cache price, or anything old to summarise", () => {
    const long = conversation(100_000)
    expect(idleCompaction({ messages: long, provider: provider({ cacheMinutes: undefined }), model: pricey, min: 0.1 })).toBeUndefined()
    expect(idleCompaction({ messages: long, provider: provider({ cacheMinutes: 5 }), model: pricey, min: 0.1 })).toBeUndefined()
    expect(MIN_CACHE_MINUTES).toBeGreaterThanOrEqual(15)
    expect(idleCompaction({ messages: long, provider: provider(), model: { ...pricey, price: { input: 4, output: 20 } }, min: 0.1 })).toBeUndefined()
    expect(idleCompaction({ messages: long, provider: provider(), model: { ...pricey, price: undefined }, min: 0.1 })).toBeUndefined()
    expect(idleCompaction({ messages: conversation(20_000), provider: provider(), model: pricey, min: 0.01 })).toBeUndefined()
  })

  test("off at 0, and never for a subscription or local model", () => {
    const long = conversation(100_000)
    expect(idleCompaction({ messages: long, provider: provider(), model: pricey, min: 0 })).toBeUndefined()
    expect(idleCompaction({ messages: long, provider: provider({ cli: "claude" } as Partial<Provider>), model: pricey, min: 0.1 })).toBeUndefined()
    // A local model has no price, so there is nothing to save.
    expect(idleCompaction({ messages: long, provider: provider({ local: true }), model: { ...pricey, price: { input: 0, output: 0 } }, min: 0.1 })).toBeUndefined()
    // The wait can be replaced for a test; the decision cannot.
    expect(idleCompaction({ messages: long, provider: provider(), model: pricey, min: 0.1 }, { CODEGOBLIN_IDLE_AFTER_MS: "3000" })!.afterMs).toBe(3000)
    expect(idleCompaction({ messages: long, provider: provider(), model: cheap, min: 0.1 }, { CODEGOBLIN_IDLE_AFTER_MS: "3000" })).toBeUndefined()
    expect(idleCompaction({ messages: long, provider: provider(), model: pricey, min: 0.1 }, {})!.afterMs).toBe(24 * 60_000)
  })

  test("the built-in providers: OpenAI qualifies on a long conversation, DeepSeek and Kimi do not", () => {
    const openai = PROVIDERS.openai!, deepseek = PROVIDERS.deepseek!, kimi = PROVIDERS.moonshotai!
    expect(idleCompaction({ messages: conversation(150_000), provider: openai, model: openai.models.find((m) => m.id === "gpt-5.6")!, min: DEFAULT_IDLE_COMPACT })).toBeDefined()
    expect(idleCompaction({ messages: conversation(95_000), provider: deepseek, model: deepseek.models.find((m) => m.id === "deepseek-v4-pro")!, min: DEFAULT_IDLE_COMPACT })).toBeUndefined()
    expect(idleCompaction({ messages: conversation(150_000), provider: kimi, model: kimi.models.find((m) => m.id === "kimi-k3")!, min: DEFAULT_IDLE_COMPACT })).toBeUndefined()
  })

  test("the note says what was saved and where the history is", () => {
    expect(idleNote(0.2034)).toContain("saves about " + String.fromCharCode(36) + "0.20")
    expect(idleNote(0.2)).toContain("/export")
    expect(idleKeepWindow(64_000)).toBe(64_000)
  })
})

describe("autonomy.idleCompact", () => {
  test("defaults to ten cents, 0 turns it off, and a typo keeps the default", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cg-idle-config-"))
    const file = path.join(dir, "codegoblin.jsonc")
    const read = (text: string) => { fs.writeFileSync(file, text); return loadConfig(file).autonomy.idleCompact }
    expect(read("{}")).toBe(0.1)
    expect(read('{ "autonomy": { "idleCompact": 0 } }')).toBe(0)
    expect(read('{ "autonomy": { "idleCompact": 0.5 } }')).toBe(0.5)
    expect(read('{ "autonomy": { "idleCompact": "yes" } }')).toBe(0.1)
    expect(read('{ "autonomy": { "idleCompact": -1 } }')).toBe(0.1)
  })
})

describe("compacting outside a turn", () => {
  const realFetch = globalThis.fetch
  afterEach(() => { globalThis.fetch = realFetch })
  const run = async (input: Parameters<typeof compactConversation>[0]) => {
    const events = []
    const generator = compactConversation(input)
    let step = await generator.next()
    while (!step.done) { events.push(step.value); step = await generator.next() }
    return { events, done: step.value }
  }

  test("the model writes the summary; what it replaces is archived; only the recent part is kept", async () => {
    let sent: { messages: Message[] } | undefined
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      sent = JSON.parse(String(init?.body))
      return new Response(JSON.stringify({ choices: [{ message: { content: "We built the guard." } }], usage: { prompt_tokens: 70_000, completion_tokens: 40, prompt_tokens_details: { cached_tokens: 69_000 } } }))
    }) as unknown as typeof fetch
    const messages = conversation(100_000)
    const archived: Message[] = []
    const { events, done } = await run({ provider: provider(), modelId: "big", apiKey: "k", messages, contextWindow: 1_000_000, keepWindow: 120_000, strict: true, archive: async (replaced) => { archived.push(...replaced) } })
    expect(done).toBe(true)
    expect(messages[0]!.role).toBe("system")
    expect(messages[1]!.content).toBe("Summary of earlier conversation:\nWe built the guard.")
    expect(conversationTokens(messages)).toBeLessThan(35_000)
    expect(archived.length).toBeGreaterThan(60)
    expect(sent!.messages.at(-1)!.content).toContain("Summarise the conversation so far")
    expect(events.find((event) => event.type === "spend")).toMatchObject({ input: 70_000, cached: 69_000 })
    expect(events.at(-1)).toMatchObject({ type: "compacted" })
  })

  test("strict: a summary that cannot be had leaves the conversation exactly as it was", async () => {
    globalThis.fetch = (async () => new Response("no", { status: 500 })) as unknown as typeof fetch
    const messages = conversation(100_000)
    const before = JSON.stringify(messages)
    let archived = 0
    await expect(run({ provider: provider(), modelId: "big", apiKey: "k", messages, contextWindow: 1_000_000, keepWindow: 120_000, strict: true, archive: async () => { archived++ } })).rejects.toThrow()
    expect(JSON.stringify(messages)).toBe(before)
    expect(archived).toBe(0)
  })

  test("nothing old enough to summarise is nothing to do", async () => {
    const messages = conversation(10_000)
    expect((await run({ provider: provider(), modelId: "big", apiKey: "k", messages, contextWindow: 1_000_000 })).done).toBe(false)
  })
})
