import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { cursorOptions, cursorEnvironment, checkCursorMessage, cursorLoginUrl } from "../src/core/cursor-policy"
import { cursorChat, cursorAuthStatus, startCursorLogin } from "../src/core/cursor-sdk"
import { apiKey, envVariable } from "../src/core/auth"
import { runCommand } from "../src/core/commands"
import { cliCompletion } from "../src/core/cli-completion"
import { runAgent, type AgentEvent, type Message } from "../src/core/agent"
import { PROVIDERS } from "../src/core/providers"
import { Permissions } from "../src/core/permission"
import { History } from "../src/core/undo"
import { requireSandbox } from "./sandbox"

const fixture = path.resolve(import.meta.dir, "fixtures/cursor-sdk.ts")
const peer = (mode = "normal") => [process.execPath, fixture, mode]
const sandbox = requireSandbox(path.join(process.env.CODEGOBLIN_DIR!, "cursor-tests"), "Cursor tests")
const collect = async (stream: AsyncGenerator<AgentEvent>) => { const events = []; for await (const event of stream) events.push(event); return events }

test("SDK policy disables all native/MCP/subagent capabilities and ambient settings", () => {
  expect(cursorOptions("explicit", "default", sandbox)).toEqual({ apiKey: "explicit", model: { id: "auto" }, tools: [], disallowedTools: ["mcp", "task"], mcpServers: {}, agents: {}, local: { cwd: sandbox, settingSources: [], enableAgentRetries: false } })
  expect(cursorEnvironment({ PATH: "bin", SystemRoot: "windows", CURSOR_API_KEY: "secret", CURSOR_BACKEND_URL: "https://evil.example", DEEPSEEK_API_KEY: "secret", CODEGOBLIN_DIR: "private", NODE_OPTIONS: "inject" })).toEqual({ PATH: "bin", SystemRoot: "windows" })
  for (const type of ["tool_call", "request", "task"] as const) expect(() => checkCursorMessage({ type, agent_id: "fixture", run_id: "fixture" } as Parameters<typeof checkCursorMessage>[0])).toThrow("native capability")
  expect(() => checkCursorMessage({ type: "system", agent_id: "fixture", run_id: "fixture", tools: ["read"] })).toThrow()
  expect(() => checkCursorMessage({ type: "assistant", agent_id: "fixture", run_id: "fixture", message: { role: "assistant", content: [{ type: "tool_use", name: "shell", id: "fixture", input: {} }] } })).toThrow()
})

test("Cursor browser login and API-key providers never share implicit authentication", () => {
  expect(apiKey("cursor")).toBe("")
  expect(envVariable("cursor-api")).toBe("CURSOR_API_KEY")
  expect(runCommand("/login cursor")).toEqual({ kind: "login", source: "cursor" })
  expect(runCommand("/connect cursor")).toMatchObject({ kind: "message", text: expect.stringContaining("/connect cursor-api") })
  expect(runCommand("/disconnect cursor")).toMatchObject({ kind: "message", text: expect.stringContaining("Revoke the SDK") })
  expect(PROVIDERS.cursor?.models[0]?.contextWindow).toBe(0)
  expect(PROVIDERS["cursor-api"]?.models[0]?.price).toBeUndefined()
})

test("discovered Cursor model IDs are sanitized without guessing price/context/effort", async () => {
  expect((await cursorAuthStatus("cursor", { command: peer() })).ready).toBe(true)
  expect(PROVIDERS.cursor?.models.map((model) => model.id)).toEqual(["default", "fixture"])
  expect((await cursorAuthStatus("cursor", { command: peer("signed-out") })).ready).toBe(false)
  const unavailable = await cursorAuthStatus("cursor", { command: peer("model-error") })
  expect(unavailable.ready).toBe(true)
  expect(unavailable.detail).toContain("key access not verified")
  expect(PROVIDERS.cursor?.models.map((model) => model.id)).toEqual(["default"])
})

test("official browser URL is required; owned SDK sign-in supports completion/cancel", async () => {
  for (const url of ["http://cursor.com/loginDeepControl?redirectTarget=sdk", "https://evil.example/loginDeepControl?redirectTarget=sdk", "https://user:password@cursor.com/loginDeepControl?redirectTarget=sdk", "https://cursor.com:444/loginDeepControl?redirectTarget=sdk", "https://cursor.com/not-login"]) expect(() => cursorLoginUrl(url)).toThrow()
  const pending = await startCursorLogin({ command: peer() })
  expect(pending.url).toContain("https://cursor.com/loginDeepControl?")
  expect(pending.status()).toBe("pending")
  await pending.cancel()
  expect(pending.status()).toBe("cancelled")
  const complete = await startCursorLogin({ command: peer("login-complete") })
  await new Promise((resolve) => setTimeout(resolve, 50))
  expect(complete.status()).toBe("complete")
  await complete.cancel()
  expect(complete.status()).toBe("complete")
  await expect(startCursorLogin({ command: peer("bad-url") })).rejects.toThrow("Could not start")
})

test("Cursor structured requests enter CG consent and preserve undo, in both auth modes", async () => {
  for (const mode of ["cursor", "cursor-api"] as const) {
    const root = await fs.mkdtemp(path.join(sandbox, "approved-"))
    await fs.writeFile(path.join(root, "cursor-fixture.txt"), "ORIGINAL")
    const messages: Message[] = [{ role: "user", content: "Fixture request" }]
    const history = new History(); history.begin("Cursor edit")
    const asked: string[] = []
    const completion: typeof cliCompletion = (input) => cliCompletion({ ...input, command: peer("credential") })
    const events = await collect(runAgent({ provider: PROVIDERS[mode]!, modelId: "default", apiKey: mode === "cursor-api" ? "explicit-key-fixture" : "", root, messages, history, completion,
      permissions: new Permissions(async (tool) => { asked.push(tool); return "once" }),
    }))
    expect(asked).toEqual(["write_file"])
    expect(await fs.readFile(path.join(root, "cursor-fixture.txt"), "utf8")).toBe("CURSOR_FIXTURE")
    expect(history.origins().get("cursor-fixture.txt")).toBe("ORIGINAL")
    expect(events.filter((event) => event.type === "spend")).toHaveLength(2)
    expect(events.find((event) => event.type === "text")).toMatchObject({ delta: "Requesting write_file." })
  }
})

test("refusal, native events, truncation and redacted SDK errors never execute a write", async () => {
  const root = await fs.mkdtemp(path.join(sandbox, "denied-"))
  const events = await collect(runAgent({ provider: PROVIDERS.cursor!, modelId: "default", apiKey: "", root, messages: [{ role: "user", content: "Fixture" }],
    completion: (input) => cliCompletion({ ...input, command: peer() }), permissions: new Permissions(async () => "reject"),
  }))
  expect(events.some((event) => event.type === "tool_denied")).toBe(true)
  expect(await fs.stat(path.join(root, "cursor-fixture.txt")).catch(() => undefined)).toBeUndefined()
  for (const mode of ["native", "error", "truncated"]) {
    const failure = await collect(cursorChat({ mode: "cursor", modelId: "default", prompt: '{"conversation":[]}', system: "Fixture", command: peer(mode) })).catch((error) => error as Error)
    expect(failure).toBeInstanceOf(Error)
    expect(String(failure)).not.toContain("secret-token-fixture")
  }
})

test("owned SDK cancellation unblocks a stream and never starts an already-aborted turn", async () => {
  const controller = new AbortController()
  const stream = cursorChat({ mode: "cursor", modelId: "default", prompt: "Fixture", system: "Fixture", command: peer("hang"), signal: controller.signal })
  expect((await stream.next()).value).toEqual({ type: "thinking", delta: "Fixture" })
  controller.abort()
  await expect(stream.next()).rejects.toThrow()
  await expect(collect(cursorChat({ mode: "cursor", modelId: "default", prompt: "Fixture", system: "Fixture", command: peer(), signal: AbortSignal.abort() }))).rejects.toThrow()
})
