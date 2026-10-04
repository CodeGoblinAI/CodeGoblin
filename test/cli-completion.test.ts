import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { runAgent, type AgentEvent, type Message } from "../src/core/agent"
import { cliCompletion, parseCliCompletion } from "../src/core/cli-completion"
import { PROVIDERS } from "../src/core/providers"
import { TOOL_SCHEMA } from "../src/core/tools"
import { Permissions } from "../src/core/permission"
import { History } from "../src/core/undo"
import { requireSandbox } from "./sandbox"

const fixture = path.resolve(import.meta.dir, "fixtures/claude-completion.ts")
const sandbox = requireSandbox(path.join(process.env.CODEGOBLIN_DIR!, "cli-tests"), "CLI completion tests")
const peer = (mode = "write") => [process.execPath, fixture, mode]
const complete = (mode = "write"): typeof cliCompletion => (input) => cliCompletion({ ...input, command: peer(mode) })
const collect = async (stream: AsyncGenerator<AgentEvent>) => { const events: AgentEvent[] = []; for await (const event of stream) events.push(event); return events }
const messages = (): Message[] => [{ role: "system", content: "CG system" }, { role: "user", content: "Fixture request" }]

test("CLI envelope validates the whole batch before returning any executable call", () => {
  const call = { name: "write_file", arguments: '{"path":"x","content":"ok"}' }
  const encode = (calls: unknown[]) => JSON.stringify({ text: "hello", calls })
  const valid = parseCliCompletion(encode([call, call]), TOOL_SCHEMA)
  expect(valid.calls[0]?.id).not.toBe(valid.calls[1]?.id)
  for (const bad of [null, { ...call, name: "Bash" }, { ...call, arguments: "{" }, { ...call, arguments: "[]" }, { ...call, dangerous: true }]) {
    expect(() => parseCliCompletion(encode([call, bad]), TOOL_SCHEMA)).toThrow("no requested tools")
  }
  expect(() => parseCliCompletion(encode(Array(17).fill(call)), TOOL_SCHEMA)).toThrow()
  expect(() => parseCliCompletion('```json\n{}\n```', TOOL_SCHEMA)).toThrow()
  expect(() => parseCliCompletion(encode([call]), [])).toThrow()
})

test("real CLI peer enters CG consent, forwards system/memory/instructions and preserves undo baseline", async () => {
  const root = await fs.mkdtemp(path.join(sandbox, "cli-approved-"))
  await fs.writeFile(path.join(root, "cli-fixture.txt"), "ORIGINAL")
  const history = new History()
  history.begin("CLI edit")
  const asked: string[] = []
  const inputMessages = messages()
  const events = await collect(runAgent({ provider: PROVIDERS["claude-code"]!, modelId: "haiku", apiKey: "", root,
    messages: inputMessages, memory: "MEMORY_SENTINEL", instructions: "INSTRUCTIONS_SENTINEL", history,
    permissions: new Permissions(async (tool) => { asked.push(tool); return "once" }), completion: complete("wire"),
  }))
  expect(asked).toEqual(["write_file"])
  expect(await fs.readFile(path.join(root, "cli-fixture.txt"), "utf8")).toBe("CLI_FIXTURE")
  expect(history.origins().get("cli-fixture.txt")).toBe("ORIGINAL")
  expect(inputMessages.some((message) => message.role === "tool")).toBe(true)
  expect(events.filter((event) => event.type === "spend")).toHaveLength(2)
  expect(events.filter((event) => event.type === "text").every((event) => event.delta[0] !== "{")).toBe(true)
  expect(events.find((event) => event.type === "text")).toMatchObject({ delta: "Requesting write_file." })
  expect(events.at(-1)?.type).toBe("turn_end")
})

test("CLI user refusal and planning/rule denial never execute requested writes", async () => {
  for (const mode of ["user", "plan", "rule"] as const) {
    const root = await fs.mkdtemp(path.join(sandbox, "cli-denied-"))
    const permissions = new Permissions(async () => "reject", () => mode === "rule" ? { "*echo*": "deny" } : {})
    permissions.planning = mode === "plan"
    if (mode === "rule") permissions.mode = "full"
    const events = await collect(runAgent({ provider: PROVIDERS["claude-code"]!, modelId: "haiku", apiKey: "", root,
      messages: messages(), permissions, completion: complete(mode === "user" ? "write" : "shell"),
    }))
    expect(events.find((event) => event.type === "tool_denied")).toMatchObject({ by: mode })
    expect(await fs.stat(path.join(root, "cli-fixture.txt")).catch(() => undefined)).toBeUndefined()
  }
})

test("native initialization, malformed response and truncation fail closed", async () => {
  for (const mode of ["native", "invalid"]) {
    const stream = cliCompletion({ modelId: "default", messages: [], tools: TOOL_SCHEMA, command: peer(mode) })
    await expect(collect(stream as AsyncGenerator<AgentEvent>)).rejects.toThrow()
  }
  const events = await collect(cliCompletion({ modelId: "default", messages: [], tools: TOOL_SCHEMA, command: peer("limited") }) as AsyncGenerator<AgentEvent>)
  expect(events.map((event) => event.type)).toEqual(["spend", "output_limit"])
})

test("CG tool requests still use MCP consent and an autonomy checkpoint", async () => {
  const root = await fs.mkdtemp(path.join(sandbox, "cli-mcp-"))
  const asked: string[] = []
  let called = false
  const events = await collect(runAgent({ provider: PROVIDERS["claude-code"]!, modelId: "default", apiKey: "", root,
    messages: messages(), checkpoint: 1, completion: complete("mcp"),
    permissions: new Permissions(async (tool) => { asked.push(tool); return tool === "autonomous run" ? "reject" : "once" }),
    extraTools: { has: (name) => name === "mcp__fixture__echo", schema: () => [{ type: "function", function: { name: "mcp__fixture__echo", description: "Echo", parameters: { type: "object" } } }], call: async () => { called = true; return "Fixture MCP result" } },
  }))
  expect(called).toBe(true)
  expect(asked).toEqual(["mcp__fixture__echo", "autonomous run"])
  expect(events.find((event) => event.type === "checkpoint")).toMatchObject({ stopped: true })
})

test("CLI compaction summaries are tool-free, counted and don't replace history on failure", async () => {
  const root = await fs.mkdtemp(path.join(sandbox, "cli-compact-"))
  const inputMessages = [...messages(), { role: "assistant" as const, content: "older detail ".repeat(400) }, { role: "user" as const, content: "Recent question" }, { role: "assistant" as const, content: "Recent answer" }, { role: "user" as const, content: "Recent request" }]
  const events = await collect(runAgent({ provider: PROVIDERS["claude-code"]!, modelId: "default", apiKey: "", root,
    messages: inputMessages, contextWindow: 1200, tools: ["write_file"], completion: complete(), permissions: new Permissions(async () => "reject"),
  }))
  expect(events.some((event) => event.type === "compacted")).toBe(true)
  expect(inputMessages.some((message) => message.content.includes("Fixture summary"))).toBe(true)
  expect(events.filter((event) => event.type === "spend").length).toBeGreaterThanOrEqual(3)
  const original = [...messages(), { role: "assistant" as const, content: "huge ".repeat(1500) }, { role: "user" as const, content: "question" }, { role: "assistant" as const, content: "answer" }, { role: "user" as const, content: "recent" }]
  const saved = JSON.stringify(original)
  await expect(collect(runAgent({ provider: PROVIDERS["claude-code"]!, modelId: "default", apiKey: "", root,
    messages: original, contextWindow: 1200, completion: complete("invalid"),
  }))).rejects.toThrow()
  expect(JSON.stringify(original)).toBe(saved)
})
