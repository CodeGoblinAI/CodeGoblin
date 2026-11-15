import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { clip, fitResult, runTool, spillDir } from "../src/core/tools"
import { runAgent } from "../src/core/agent"
import type { Provider } from "../src/core/providers"

const NL = String.fromCharCode(10)
const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), "cg-output-"))

describe("oversized tool output", () => {
  test("short text is untouched; long text keeps its start and its end", () => {
    expect(clip("short")).toBe("short")
    const long = "START" + "x".repeat(60_000) + "THE-ERROR-AT-THE-END"
    const cut = clip(long)
    expect(cut.length).toBeLessThan(25_000)
    expect(cut.startsWith("START")).toBe(true)
    expect(cut.endsWith("THE-ERROR-AT-THE-END")).toBe(true)
    expect(cut).toContain("characters cut from the middle")
  })

  test("the whole result goes to a file the model can read in parts", async () => {
    const lines = Array.from({ length: 6000 }, (_, i) => "line " + (i + 1) + " of the build log")
    const fitted = await fitResult(lines.join(NL), "call/1")
    const file = /is in (.+\.txt) - read_file/.exec(fitted)?.[1]
    expect(file).toBeDefined()
    expect(path.dirname(file!)).toBe(spillDir())
    expect(fs.readFileSync(file!, "utf8").split(NL).length).toBe(6000)
    // From a project elsewhere, by the absolute path it was given.
    const middle = await runTool("read_file", { path: file, offset: 3000, limit: 3 }, temp())
    expect(middle).toBe(["line 3000 of the build log", "line 3001 of the build log", "line 3002 of the build log"].join(NL) + NL + "(lines 3000-3002 of 6000)")
    expect(await fitResult("small", "call-2")).toBe("small")
  })

  test("read_file still refuses a path outside the project that is not a spill file", async () => {
    const outside = path.join(temp(), "secret.txt")
    fs.writeFileSync(outside, "no")
    expect(await runTool("read_file", { path: outside }, temp())).toContain("escapes the working directory")
    expect(await runTool("read_file", { path: path.join(spillDir(), "..", "secret.txt") }, temp())).toContain("escapes the working directory")
  })

  test("read_file without a range is as before, and a range past the end says so", async () => {
    const root = temp()
    fs.writeFileSync(path.join(root, "a.txt"), "one" + NL + "two" + NL + "three")
    expect(await runTool("read_file", { path: "a.txt" }, root)).toBe("one" + NL + "two" + NL + "three")
    expect(await runTool("read_file", { path: "a.txt", offset: 2, limit: 1 }, root)).toBe("two" + NL + "(lines 2-2 of 3)")
    expect(await runTool("read_file", { path: "a.txt", offset: 9 }, root)).toContain("nothing at line 9")
  })

  test("a command that prints a great deal comes back with both ends and a file", async () => {
    const root = temp()
    fs.writeFileSync(path.join(root, "big.js"), "for (let i = 1; i <= 5000; i++) console.log('row ' + i + ' ' + 'x'.repeat(20)); console.log('FAILED: the last line')")
    const raw = await runTool("shell", { command: "bun big.js" }, root)
    expect(raw.length).toBeGreaterThan(100_000)
    const fitted = await fitResult(raw, "shell-1")
    expect(fitted).toContain("row 1 ")
    expect(fitted).toContain("FAILED: the last line")
    expect(fitted).toContain("read_file with offset and limit")
  })
})

describe("a model repeating itself", () => {
  const original = globalThis.fetch
  afterEach(() => { globalThis.fetch = original })
  const provider: Provider = { id: "test", label: "Test", baseUrl: "https://example.invalid/v1/chat/completions", models: [{ id: "m", label: "M", contextWindow: 128000 }] }
  const sse = (...chunks: unknown[]) => new Response(chunks.map((c) => "data: " + JSON.stringify(c)).join(NL + NL) + NL + NL + "data: [DONE]" + NL + NL, { headers: { "content-type": "text/event-stream" } })
  const call = (id: string, name: string, args: string) => sse({ choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name, arguments: args } }] } }] })

  async function toolResults(steps: (step: number, root: string) => [string, string] | undefined): Promise<string[]> {
    const root = temp()
    fs.writeFileSync(path.join(root, "a.txt"), "same")
    const bodies: any[] = []
    let step = 0
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)))
      const next = steps(step, root)
      step++
      return next ? call("c" + step, next[0], next[1]) : sse({ choices: [{ delta: { content: "done" } }] })
    }) as unknown as typeof fetch
    for await (const _ of runAgent({ provider, modelId: "m", apiKey: "k", messages: [{ role: "user", content: "go" }], root, maxTurns: 12 })) { /* drained */ }
    return bodies.at(-1).messages.filter((m: any) => m.role === "tool").map((m: any) => String(m.content))
  }

  test("the third, fifth and eighth identical result carry a note; the others do not", async () => {
    const results = await toolResults((step) => (step < 8 ? ["read_file", '{"path":"a.txt"}'] : undefined))
    expect(results.length).toBe(8)
    const noted = results.map((r) => r.includes("gave this same result"))
    expect(noted).toEqual([false, false, true, false, true, false, false, true])
    expect(results[2]).toContain("third time read_file")
    expect(results[2]!.startsWith("same")).toBe(true)
  })

  test("the same call with a different answer each time is never noted", async () => {
    const results = await toolResults((step, root) => {
      if (step >= 5) return undefined
      fs.writeFileSync(path.join(root, "a.txt"), "version " + step)
      return ["read_file", '{"path":"a.txt"}']
    })
    expect(results.length).toBe(5)
    expect(results.some((r) => r.includes("gave this same result"))).toBe(false)
  })
})

describe("a provider that is busy", () => {
  const original = globalThis.fetch
  afterEach(() => { globalThis.fetch = original })
  const provider: Provider = { id: "test", label: "Test", baseUrl: "https://example.invalid/v1/chat/completions", models: [{ id: "m", label: "M", contextWindow: 128000 }] }
  const answer = () => new Response("data: " + JSON.stringify({ choices: [{ delta: { content: "hello" } }] }) + NL + NL + "data: [DONE]" + NL + NL)

  async function run(responses: (() => Response | Promise<Response>)[], extra: Record<string, unknown> = {}) {
    let calls = 0
    globalThis.fetch = (async () => { const next = responses[Math.min(calls, responses.length - 1)]!; calls++; return next() }) as unknown as typeof fetch
    const events: any[] = []
    let error = ""
    try {
      for await (const event of runAgent({ provider, modelId: "m", apiKey: "k", messages: [{ role: "user", content: "hi" }], root: process.cwd(), maxTurns: 1, retryWaits: [1, 1], ...extra } as never)) events.push(event)
    } catch (caught) { error = caught instanceof Error ? caught.message : String(caught) }
    return { calls, error, retries: events.filter((event) => event.type === "retry"), text: events.filter((event) => event.type === "text").map((event) => event.delta).join("") }
  }

  test("a 429 and a dropped connection are tried again, and the answer arrives", async () => {
    const result = await run([() => new Response("slow down", { status: 429 }), () => { throw new TypeError("fetch failed") }, answer])
    expect(result.calls).toBe(3)
    expect(result.text).toBe("hello")
    expect(result.retries.map((event) => event.reason)).toEqual(["HTTP 429", "no connection"])
  })

  test("it gives up after the last wait, with the provider's own words", async () => {
    const result = await run([() => new Response("overloaded", { status: 503 })])
    expect(result.calls).toBe(3)
    expect(result.error).toContain("returned 503")
    expect(result.error).toContain("overloaded")
  })

  test("a refusal is not a busy signal: a bad key or a bad request is reported at once", async () => {
    for (const status of [400, 401, 402, 404]) {
      const result = await run([() => new Response("no", { status })])
      expect(result.calls).toBe(1)
      expect(result.retries.length).toBe(0)
    }
  })

  test("retry-after is honoured, and an empty list turns retrying off", async () => {
    const waited = await run([() => new Response("", { status: 429, headers: { "retry-after": "0.05" } }), answer])
    expect(waited.retries[0].waitMs).toBe(50)
    const off = await run([() => new Response("busy", { status: 429 }), answer], { retryWaits: [] })
    expect(off.calls).toBe(1)
    expect(off.error).toContain("returned 429")
  })
})
