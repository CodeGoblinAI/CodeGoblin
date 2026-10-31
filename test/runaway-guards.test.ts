import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { runAgent, type AgentEvent, type Message } from "../src/core/agent"
import type { Provider } from "../src/core/providers"
import { Permissions } from "../src/core/permission"
import { sessionFacts } from "../src/core/session-facts"
import { redactSecrets } from "../src/core/tools"
import { storedSecrets } from "../src/core/auth"
import { grepFiles, globFiles, relativePattern, walkNote } from "../src/core/search"
import { toMarkdown } from "../src/core/export"

/**
 * The guards added after a real runaway on 2026-10-31: asked "what effort are
 * you running at?", DeepSeek V4.1 Flash searched the user's whole machine for
 * 84 steps (3.2M input tokens, $1.00), printed auth.json into the conversation,
 * and could not be stopped while a grep walked the home folder.
 */
const NEWLINE = String.fromCharCode(10)
const priced: Provider = {
  id: "test",
  label: "Test Labs",
  baseUrl: "https://example.invalid/v1/chat/completions",
  models: [{ id: "pricey", label: "Pricey", contextWindow: 128000, price: { input: 1, output: 1 }, reasoning: true, efforts: ["none", "low", "high", "max"], defaultEffort: "high" }],
}

function stream(...chunks: unknown[]): Response {
  const text = chunks.map((chunk) => "data: " + JSON.stringify(chunk)).join(NEWLINE + NEWLINE) + NEWLINE + NEWLINE + "data: [DONE]" + NEWLINE + NEWLINE
  return new Response(text, { status: 200 })
}
/** A step that asks for one listing and reports a usage that costs $0.20 at $1/M. */
const costlyStep = (id: string) => () => stream(
  { choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name: "list_files", arguments: '{"path":"."}' } }] } }] },
  { choices: [], usage: { prompt_tokens: 200_000, completion_tokens: 0 } },
)
const answers = (text: string) => () => stream({ choices: [{ delta: { content: text } }] })

const realFetch = globalThis.fetch
const bodies: { messages: { role: string; content: unknown }[] }[] = []
function serve(...turns: (() => Response)[]) {
  bodies.length = 0
  let at = 0
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)))
    return turns[Math.min(at++, turns.length - 1)]!()
  }) as unknown as typeof fetch
  return () => at
}
afterEach(() => { globalThis.fetch = realFetch })

async function drive(input: Partial<Parameters<typeof runAgent>[0]> & { messages: Message[] }) {
  const events: AgentEvent[] = []
  for await (const event of runAgent({ provider: priced, modelId: "pricey", apiKey: "not-a-real-key", root: process.cwd(), maxTurns: 10, checkpoint: 0, ...input })) events.push(event)
  return events
}

describe("the model is told about its own session", () => {
  test("model, effort and directory reach the wire, so 'what effort are you on?' needs no search", async () => {
    serve(answers("auto, which is high on this model"))
    await drive({ messages: [{ role: "system", content: "base" }, { role: "user", content: "what effort are you running at?" }], spendLimit: 0 })
    const system = String(bodies[0]!.messages[0]!.content)
    expect(system).toContain("About this session")
    expect(system).toContain("Model: Test Labs Pricey (test/pricey)")
    expect(system).toContain("Reasoning effort: auto")
    expect(system).toContain("(high)")
    expect(system).toContain("is a different, older app")
  })

  test("a set level, a model with none, and the home folder are each said plainly", () => {
    const home = path.join(os.tmpdir(), "someone")
    expect(sessionFacts({ provider: priced, modelId: "pricey", effort: "max", root: "C:/proj", home })).toContain("Reasoning effort: max (this model's levels: none, low, high, max)")
    const flat: Provider = { ...priced, models: [{ id: "flat", label: "Flat", contextWindow: 1 }] }
    expect(sessionFacts({ provider: flat, modelId: "flat", root: "C:/proj", home })).toContain("this model has no effort setting")
    expect(sessionFacts({ provider: priced, modelId: "pricey", root: home, home })).toContain("the user's home folder, not a project")
    expect(sessionFacts({ provider: priced, modelId: "pricey", root: path.join(home, "proj"), home })).not.toContain("home folder")
  })
})

describe("the spend brake", () => {
  test("is asked once a prompt passes the limit, and a no stops the turn there", async () => {
    const asked: string[] = []
    const permissions = new Permissions(async (_tool, detail) => { asked.push(detail); return "reject" })
    permissions.mode = "full"
    const served = serve(costlyStep("a"), costlyStep("b"), answers("done"))
    const events = await drive({ messages: [{ role: "user", content: "go" }], permissions, spendLimit: 0.3 })
    // $0.20 after one step is under the limit; $0.40 after two is over it.
    expect(asked).toEqual(["$0.40 spent on this prompt - keep going"])
    expect(events.find((event) => event.type === "checkpoint")).toMatchObject({ stopped: true, spent: 0.4 })
    expect(served()).toBe(2)
  })

  test("a yes carries on and asks again only after another full limit", async () => {
    const asked: string[] = []
    const permissions = new Permissions(async (_tool, detail) => { asked.push(detail); return "once" })
    permissions.mode = "full"
    serve(costlyStep("a"), costlyStep("b"), costlyStep("c"), answers("done"))
    await drive({ messages: [{ role: "user", content: "go" }], permissions, spendLimit: 0.3 })
    // Asked at $0.40, next at $0.60 or more: $0.60 after the third step.
    expect(asked).toEqual(["$0.40 spent on this prompt - keep going", "$0.60 spent on this prompt - keep going"])
  })

  test("an unpriced model is never stopped for money", async () => {
    let asked = 0
    const permissions = new Permissions(async () => { asked++; return "reject" })
    permissions.mode = "full"
    serve(costlyStep("a"), costlyStep("b"), answers("done"))
    const free: Provider = { ...priced, models: [{ id: "pricey", label: "Free", contextWindow: 128000 }] }
    await drive({ provider: free, messages: [{ role: "user", content: "go" }], permissions, spendLimit: 0.01 })
    expect(asked).toBe(0)
  })
})

describe("stored keys never reach the model", () => {
  test("a key a tool prints is hidden in the result the model is sent and the conversation keeps", async () => {
    const secret = "sk-runaway-guard-" + "0123456789abcdef"
    process.env.RUNAWAY_TEST_API_KEY = secret
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cg-redact-"))
    fs.writeFileSync(path.join(dir, "auth.json"), JSON.stringify({ deepseek: { type: "api", key: secret } }))
    try {
      serve(() => stream({ choices: [{ delta: { tool_calls: [{ index: 0, id: "r", function: { name: "read_file", arguments: '{"path":"auth.json"}' } }] } }] }), answers("done"))
      const messages: Message[] = [{ role: "user", content: "show me auth.json" }]
      await drive({ root: dir, messages })
      const result = messages.find((message) => message.role === "tool")!.content
      expect(result).not.toContain(secret)
      expect(result).toContain("[stored secret hidden by CG-Next]")
      expect(JSON.stringify(bodies.at(-1))).not.toContain(secret)
    } finally {
      delete process.env.RUNAWAY_TEST_API_KEY
    }
  })

  test("secrets come from the store's key fields and secret-named variables, not from labels or short values", () => {
    const secrets = storedSecrets({ SOME_API_KEY: "a-long-secret-value-123", SOME_URL: "https://not-a-secret.example.com", SHORT_TOKEN: "abc" })
    expect(secrets).toContain("a-long-secret-value-123")
    expect(secrets).not.toContain("https://not-a-secret.example.com")
    expect(secrets).not.toContain("abc")
    expect(redactSecrets("key=a-long-secret-value-123;", ["a-long-secret-value-123"])).toBe("key=[stored secret hidden by CG-Next];")
  })

  test("an export or /copy of an older conversation that holds a key is scrubbed", () => {
    const markdown = toMarkdown({ id: "s", title: "t", created: 0, updated: 0, provider: "test", model: "pricey", messages: [{ role: "tool", content: "deepseek key a-long-secret-value-123" }] } as never, 0)
    expect(redactSecrets(markdown, ["a-long-secret-value-123"])).not.toContain("a-long-secret-value-123")
  })
})

describe("searches stay bounded and stoppable", () => {
  test("an absolute pattern inside the root is made relative; outside it is refused, not walked", () => {
    const root = path.join(os.tmpdir(), "proj")
    expect(relativePattern(root, root.split(path.sep).join("/") + "/src/**/*.ts")).toBe("src/**/*.ts")
    expect(relativePattern(root, "src/**/*.ts")).toBe("src/**/*.ts")
    if (process.platform === "win32") expect(() => relativePattern(root, "D:/elsewhere/**")).toThrow("outside the working directory")
  })

  test("grep with an absolute include finds the file instead of walking everything for nothing", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cg-grep-abs-"))
    fs.mkdirSync(path.join(dir, "src"))
    fs.writeFileSync(path.join(dir, "src", "a.ts"), "const effort = 1\n")
    const found = await grepFiles(dir, "effort", path.join(dir, "src") + "/**/*.ts")
    expect(found.matches).toEqual(["src/a.ts:1: const effort = 1"])
  })

  test("a stop ends grep and glob part way, and the result says so", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cg-grep-stop-"))
    for (let i = 0; i < 30; i++) fs.writeFileSync(path.join(dir, `f${i}.txt`), "needle\n")
    const stop = new AbortController()
    stop.abort()
    const grep = await grepFiles(dir, "needle", undefined, stop.signal)
    expect(grep.matches).toEqual([])
    expect(walkNote(grep.end)).toBe("stopped by the user part way through")
    const end = { stopped: false, capped: false }
    expect(await globFiles(dir, "*.txt", 200, stop.signal, end)).toEqual([])
    expect(end.stopped).toBe(true)
    expect(walkNote({ stopped: false, capped: true })).toContain("narrow it")
  })
})
