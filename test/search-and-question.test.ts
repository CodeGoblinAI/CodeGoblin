import { afterEach, describe, expect, test } from "bun:test"
import { runAgent, type AgentEvent, type Message } from "../src/core/agent"
import type { Provider } from "../src/core/providers"
import { Permissions, askedFor, coverOf } from "../src/core/permission"
import { parseSearchResponse, searchWeb } from "../src/core/websearch"
import { answerText, parseQuestion, type Question } from "../src/core/question"
import { BrowserConsent } from "../src/web/consent"

const NEWLINE = String.fromCharCode(10)
const provider: Provider = { id: "test", label: "Test", baseUrl: "https://example.invalid/v1/chat/completions", models: [{ id: "m", label: "M", contextWindow: 128000 }] }
const stream = (...chunks: unknown[]) =>
  new Response(chunks.map((chunk) => "data: " + JSON.stringify(chunk)).join(NEWLINE + NEWLINE) + NEWLINE + NEWLINE + "data: [DONE]" + NEWLINE + NEWLINE, { status: 200 })
const call = (name: string, args: unknown) => () => stream({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name, arguments: JSON.stringify(args) } }] } }] })
const says = (text: string) => () => stream({ choices: [{ delta: { content: text } }] })

const realFetch = globalThis.fetch
const bodies: { messages: Message[]; tools?: { function: { name: string } }[] }[] = []
function serve(...turns: (() => Response)[]) {
  bodies.length = 0
  let at = 0
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)))
    return turns[Math.min(at++, turns.length - 1)]!()
  }) as unknown as typeof fetch
}
afterEach(() => { globalThis.fetch = realFetch })
async function drive(input: Partial<Parameters<typeof runAgent>[0]>) {
  const events: AgentEvent[] = []
  for await (const event of runAgent({ provider, modelId: "m", apiKey: "k", root: process.cwd(), maxTurns: 4, checkpoint: 0, spendLimit: 0, messages: [{ role: "user", content: "go" }], ...input })) events.push(event)
  return events
}
const toolResult = () => String(bodies.at(-1)!.messages.find((m) => m.role === "tool")?.content ?? "")

describe("web search", () => {
  test("reads the answer from an event stream or plain JSON, and reports a service error", () => {
    const payload = JSON.stringify({ result: { content: [{ type: "text", text: "Title: Bun 1.4" }] } })
    expect(parseSearchResponse("event: message" + NEWLINE + "data: " + payload + NEWLINE)).toBe("Title: Bun 1.4")
    expect(parseSearchResponse(payload)).toBe("Title: Bun 1.4")
    expect(parseSearchResponse("")).toBeUndefined()
    expect(() => parseSearchResponse(JSON.stringify({ error: { message: "bad query" } }))).toThrow("bad query")
  })

  test("sends one JSON-RPC call with the query, and a key only when there is one", async () => {
    const sent: { url: string; body: { params: { name: string; arguments: { query: string; numResults: number } } } }[] = []
    const fake = (async (url: string, init: RequestInit) => {
      sent.push({ url, body: JSON.parse(String(init.body)) })
      return new Response("data: " + JSON.stringify({ result: { content: [{ type: "text", text: "found" }] } }), { status: 200 })
    }) as unknown as typeof fetch
    expect(await searchWeb("bun release", { fetch: fake, key: "" })).toBe("found")
    expect(await searchWeb("bun release", { fetch: fake, key: "abc", numResults: 50 })).toBe("found")
    expect(sent[0]!.url).toBe("https://mcp.exa.ai/mcp")
    expect(sent[0]!.body.params).toMatchObject({ name: "web_search_exa", arguments: { query: "bun release", numResults: 6 } })
    expect(sent[1]!.url).toBe("https://mcp.exa.ai/mcp?exaApiKey=abc")
    expect(sent[1]!.body.params.arguments.numResults).toBe(10)
  })

  test("says plainly when it is rate limited, empty, or given nothing to search", async () => {
    const answering = (response: Response) => (async () => response) as unknown as typeof fetch
    await expect(searchWeb("x", { fetch: answering(new Response("", { status: 429 })), key: "" })).rejects.toThrow("rate limiting")
    expect(await searchWeb("x", { fetch: answering(new Response("{}", { status: 200 })), key: "" })).toBe("no results - try different words")
    await expect(searchWeb("   ")).rejects.toThrow("give a search query")
  })

  test("asks before searching like webfetch, shows the query, and is allowed while planning", async () => {
    const asked: string[] = []
    const permissions = new Permissions(async (tool, detail) => { asked.push(askedFor(tool, detail)); return "once" })
    const detail = JSON.stringify({ query: "latest bun release" })
    expect((await permissions.decide("websearch", detail)).allowed).toBe(true)
    expect(asked).toEqual(['"latest bun release"'])
    expect(coverOf("websearch", detail)).toBe("every websearch call")
    permissions.planning = true
    expect((await permissions.decide("websearch", detail)).allowed).toBe(true)
    permissions.mode = "full"
    permissions.planning = false
    expect((await permissions.decide("websearch", detail)).allowed).toBe(true)
    expect(asked.length).toBe(2)
  })

  test("is offered to the model", async () => {
    serve(says("hi"))
    await drive({})
    expect(bodies[0]!.tools?.some((tool) => tool.function.name === "websearch")).toBe(true)
  })
})

describe("the question tool", () => {
  test("cleans what the model sends: trimmed, no Other, no repeats, at most six", () => {
    const q = parseQuestion({ question: "  Which  database? ", options: ["Postgres (Recommended)", { label: "SQLite", description: "a file" }, "sqlite", "Other", "A", "B", "C", "D", "E"], multiple: true })
    expect(q.question).toBe("Which database?")
    expect(q.options.map((o) => o.label)).toEqual(["Postgres (Recommended)", "SQLite", "A", "B", "C", "D"])
    expect(q.options[1]).toEqual({ label: "SQLite", description: "a file" })
    expect(q.multiple).toBe(true)
    expect(parseQuestion({ question: "ok?", options: ["yes"], multiple: true }).multiple).toBe(false)
    expect(() => parseQuestion({ question: " " })).toThrow("empty")
  })

  test("tells the model the answer, or that it was dismissed and not to ask again", () => {
    const q: Question = { question: "Which?", options: [], multiple: false }
    expect(answerText(q, ["Postgres"])).toBe('The user answered "Which?": "Postgres".')
    expect(answerText(q, undefined)).toContain("Do not ask it again")
  })

  test("is offered only where someone can answer, and the answer reaches the model", async () => {
    serve(says("hi"))
    await drive({})
    expect(bodies[0]!.tools?.some((tool) => tool.function.name === "question")).toBe(false)

    const seen: Question[] = []
    serve(call("question", { question: "Tabs or spaces?", options: ["Tabs", "Spaces"] }), says("Spaces it is."))
    const permissions = new Permissions(async () => { throw new Error("a question is not a permission") })
    const events = await drive({ permissions, askUser: async (question) => { seen.push(question); return ["Spaces"] } })
    expect(bodies[0]!.tools?.some((tool) => tool.function.name === "question")).toBe(true)
    expect(seen[0]?.options.map((o) => o.label)).toEqual(["Tabs", "Spaces"])
    expect(toolResult()).toBe('The user answered "Tabs or spaces?": "Spaces".')
    expect(events.some((event) => event.type === "text")).toBe(true)
  })

  test("a model that calls it anyway, with nobody there, is told to decide", async () => {
    serve(call("question", { question: "Which?" }), says("ok"))
    await drive({})
    expect(toolResult()).toContain("there is no one to ask")
  })

  test("in the browser: the question goes down the stream, the answer comes back, junk counts as dismissed", async () => {
    const consent = new BrowserConsent()
    const events: { type: string; id: string }[] = []
    const ask = consent.askerFor("s1", (event) => events.push(event as { type: string; id: string }))
    const q: Question = { question: "Which?", options: [{ label: "A" }], multiple: false }
    const first = ask(q)
    expect(events[0]?.type).toBe("question")
    expect(consent.answerQuestion(events[0]!.id, ["  A "])).toBe(true)
    expect(await first).toEqual(["A"])
    expect(consent.answerQuestion(events[0]!.id, ["A"])).toBe(false)
    const second = ask(q)
    consent.answerQuestion(events[1]!.id, [{ not: "text" }])
    expect(await second).toBeUndefined()
    const third = ask(q)
    consent.abandon("s1")
    expect(await third).toBeUndefined()
    const stop = new AbortController()
    const fourth = ask(q, stop.signal)
    stop.abort()
    expect(await fourth).toBeUndefined()
  })
})
