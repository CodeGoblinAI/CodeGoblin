import { afterEach, describe, expect, test } from "bun:test"
import path from "node:path"
import type { McpServer } from "../src/core/config"
import {
  LATEST_PROTOCOL_VERSION,
  McpClient,
  McpManager,
  SseParser,
  formatToolResult,
  launchable,
  toolNameFor,
} from "../src/core/mcp"

const fixture = path.join(import.meta.dir, "fixtures", "mcp-fixture-server.ts")

const local = (environment: Record<string, string> = {}, extra: { timeout?: number; enabled?: boolean } = {}): McpServer => ({
  type: "local",
  command: [process.execPath, fixture],
  environment,
  enabled: extra.enabled ?? true,
  ...(extra.timeout ? { timeout: extra.timeout } : {}),
})

const open: { close(): Promise<void> }[] = []
afterEach(async () => {
  await Promise.all(open.splice(0).map((each) => each.close()))
})

async function connected(config: McpServer = local(), name = "fixture") {
  const client = new McpClient(name, config)
  open.push(client)
  await client.connect()
  return client
}

async function until(check: () => boolean, limit = 3000) {
  const started = Date.now()
  while (!check()) {
    if (Date.now() - started > limit) throw new Error("gave up waiting")
    await new Promise((done) => setTimeout(done, 25))
  }
}

describe("a server started as a child process", () => {
  test("connects, and lists every tool across pages", async () => {
    const client = await connected()
    expect(client.error).toBeUndefined()
    expect(client.status).toBe("connected")
    expect(client.protocolVersion).toBe(LATEST_PROTOCOL_VERSION)
    expect(client.serverInfo?.name).toBe("fixture")
    // echo is on the first page and env on the second.
    expect(client.tools.map((tool) => tool.name)).toContain("echo")
    expect(client.tools.map((tool) => tool.name)).toContain("env")
  })

  test("a call comes back as text, after the client has said it is initialized", async () => {
    const client = await connected()
    expect(await client.callTool("echo", { text: "hi" })).toBe("echo: hi")
  })

  test("a tool that fails reaches the model as an error", async () => {
    const client = await connected()
    expect(await client.callTool("fail", {})).toBe("error: it broke")
  })

  test("a picture is described rather than silently dropped", async () => {
    const result = await (await connected()).callTool("picture", {})
    expect(result).toContain("here")
    expect(result).toContain("[image image/png")
  })

  test("structured content is shown when there is nothing else", async () => {
    expect(await (await connected()).callTool("structured", {})).toContain('"answer": 42')
  })

  test("the environment in the config reaches the server", async () => {
    const client = await connected(local({ FIXTURE_VALUE: "from-config" }))
    expect(await client.callTool("env", {})).toBe("from-config")
  })

  test("a server that never answers times out, naming the server and what was asked", async () => {
    const client = await connected(local({}, { timeout: 1500 }))
    expect(client.status).toBe("connected")
    expect(await client.callTool("slow", {})).toBe("error: fixture did not answer tools/call within 1.5s")
  })

  test("a server speaking a protocol this client does not is refused", async () => {
    const client = await connected(local({ FIXTURE_PROTOCOL: "1999-01-01" }))
    expect(client.status).toBe("failed")
    expect(client.error).toContain("1999-01-01")
  })

  test("a server that dies on start says why", async () => {
    const client = await connected(local({ FIXTURE_EXIT_AT_START: "1" }))
    expect(client.status).toBe("failed")
    expect(client.error).toContain("told to fail at start")
  })

  test("a command that does not exist fails, naming the command", async () => {
    const client = await connected({ type: "local", command: ["cg-no-such-program-xyz"], environment: {}, enabled: true })
    expect(client.status).toBe("failed")
    expect(client.error).toContain("cg-no-such-program-xyz")
  })

  test("a question from the server gets an answer, even one this client cannot help with", async () => {
    const client = await connected()
    expect(await client.callTool("ask_client", {})).toBe("roots: -32601; ping: ok")
  })

  test("a changed tool list is picked up without reconnecting", async () => {
    const client = await connected()
    let told = false
    client.onToolsChanged = () => (told = true)
    expect(await client.callTool("grow", {})).toBe("grew")
    await until(() => told)
    expect(client.tools.map((tool) => tool.name)).toContain("grown")
  })

  test("a disabled server is never started", async () => {
    const client = await connected(local({}, { enabled: false }))
    expect(client.status).toBe("disabled")
    expect(client.tools).toEqual([])
    expect(await client.callTool("echo", { text: "x" })).toContain("is disabled")
  })
})

describe("every server's tools as one list", () => {
  test("offered under names the wire accepts, and routed back to the right server", async () => {
    const manager = new McpManager({ fixture: local() })
    open.push(manager)
    await manager.start()

    const names = manager.schema().map((entry) => entry.function.name)
    expect(names).toContain("mcp__fixture__echo")
    for (const name of names) expect([name, /^[a-zA-Z0-9_-]{1,64}$/.test(name)]).toEqual([name, true])

    expect(manager.has("mcp__fixture__echo")).toBe(true)
    expect(await manager.call("mcp__fixture__echo", { text: "routed" })).toBe("echo: routed")
    expect(await manager.call("mcp__fixture__nothing", {})).toBe("unknown tool: mcp__fixture__nothing")
  })

  test("one broken server leaves the others working, and says what broke", async () => {
    const manager = new McpManager({
      good: local(),
      broken: { type: "local", command: ["cg-no-such-program-xyz"], environment: {}, enabled: true },
    })
    open.push(manager)
    await manager.start()

    const statuses = Object.fromEntries(manager.statuses().map((each) => [each.name, each]))
    expect(statuses.good!.status).toBe("connected")
    expect(statuses.broken!.status).toBe("failed")
    expect(statuses.broken!.error).toContain("cg-no-such-program-xyz")
    expect(manager.schema().every((entry) => entry.function.name.startsWith("mcp__good__"))).toBe(true)
  })

  test("a server that drops out mid-session is started again before the next message", async () => {
    // Seen in the terminal: the fixture server was killed, its tools vanished,
    // and nothing brought it back.
    const manager = new McpManager({ fixture: local() })
    open.push(manager)
    await manager.start()
    const client = manager.clients[0]!
    ;(client as unknown as { lost(reason: string): void }).lost("bun exited with code 1")
    expect(client.status).toBe("failed")
    expect(manager.has("mcp__fixture__echo")).toBe(false)

    await manager.settled(10_000)
    expect(client.status).toBe("connected")
    expect(await manager.call("mcp__fixture__echo", { text: "back" })).toBe("echo: back")
  })

  test("a server that never started is not retried, and the model is told it is down", async () => {
    // Seen in the terminal: with the servers down and nothing said, the model
    // called an unrelated DeepWiki tool in their place and said "broken" was not configured.
    const manager = new McpManager({
      good: local(),
      broken: { type: "local", command: ["cg-no-such-program-xyz"], environment: {}, enabled: true },
    })
    open.push(manager)
    await manager.settled(10_000)
    const broken = manager.clients.find((client) => client.name === "broken")!
    expect(broken.dropped).toBe(false)
    expect(broken.restarts).toBe(0)
    const notice = manager.notice()!
    expect(notice).toContain("broken")
    expect(notice).toContain("cg-no-such-program-xyz")
    expect(notice).toContain("not running")
    expect(notice).not.toContain("- good")
  })

  test("with every server working there is nothing to tell the model", async () => {
    const manager = new McpManager({ fixture: local() })
    open.push(manager)
    await manager.start()
    expect(manager.notice()).toBeUndefined()
  })

  test("waiting for servers has a limit", async () => {
    const manager = new McpManager({ slow: local({}, { timeout: 5000 }) })
    open.push(manager)
    // Nothing connects in 1ms; the wait still ends.
    const started = Date.now()
    await manager.settled(1)
    expect(Date.now() - started).toBeLessThan(1000)
  })
})

describe("naming a tool for the wire", () => {
  test("a plain name is kept as it reads", () => {
    expect(toolNameFor("github", "create_issue")).toBe("mcp__github__create_issue")
  })

  test("characters the wire refuses are replaced, and a hash keeps the result unique", () => {
    const dotted = toolNameFor("notion", "pages.search")
    const underscored = toolNameFor("notion", "pages_search")
    expect(/^[a-zA-Z0-9_-]+$/.test(dotted)).toBe(true)
    expect(dotted).not.toBe(underscored)
  })

  test("a long name is cut to 64, and two that differ only at the end stay different", () => {
    const a = toolNameFor("a-server-with-a-rather-long-name", "a_tool_with_an_even_longer_name_ending_in_one")
    const b = toolNameFor("a-server-with-a-rather-long-name", "a_tool_with_an_even_longer_name_ending_in_two")
    expect(a.length).toBe(64)
    expect(b.length).toBe(64)
    expect(a).not.toBe(b)
  })
})

describe("starting a command on Windows", () => {
  test("a bare .cmd shim is started by its bare name", () => {
    expect(launchable(["npx.cmd", "-y", "server"], "win32")).toEqual(["npx", "-y", "server"])
  })

  test("a shim with a directory, or any other platform, is left alone", () => {
    expect(launchable(["C:/tools/npx.cmd"], "win32")).toEqual(["C:/tools/npx.cmd"])
    expect(launchable(["npx.cmd"], "linux")).toEqual(["npx.cmd"])
  })
})

describe("reading results and streams", () => {
  test("an empty result says so, and a missing one is an error", () => {
    expect(formatToolResult({ content: [] })).toBe("(the tool returned nothing)")
    expect(formatToolResult(undefined)).toBe("error: the server returned no result")
  })

  test("events split across chunks and CRLF line endings still arrive whole", () => {
    const parser = new SseParser()
    expect(parser.push("event: message\r")).toEqual([])
    expect(parser.push("\ndata: {\"a\":")).toEqual([])
    expect(parser.push("1}\r\n\r\ndata: line one\ndata: line two\n\n")).toEqual(['{"a":1}', "line one\nline two"])
  })
})

describe("a remote server over Streamable HTTP", () => {
  type Seen = { method: string; session: string | null; version: string | null; authorization: string | null }

  function remoteServer(options: { failInitialize?: number } = {}) {
    const seen: Seen[] = []
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(request) {
        if (request.method === "DELETE") {
          seen.push({ method: "DELETE", session: request.headers.get("mcp-session-id"), version: null, authorization: null })
          return new Response(null, { status: 200 })
        }
        const message = (await request.json()) as { id?: number; method: string; params?: any }
        seen.push({
          method: message.method,
          session: request.headers.get("mcp-session-id"),
          version: request.headers.get("mcp-protocol-version"),
          authorization: request.headers.get("authorization"),
        })
        const json = (result: unknown, headers: Record<string, string> = {}) =>
          Response.json({ jsonrpc: "2.0", id: message.id, result }, { headers })

        if (message.method === "initialize") {
          if (options.failInitialize) return new Response("go away", { status: options.failInitialize })
          return json(
            { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "remote" } },
            { "mcp-session-id": "sess-1" },
          )
        }
        if (message.id === undefined) return new Response(null, { status: 202 })
        if (message.method === "tools/list") {
          // Answered as an event stream, with a notification ahead of the answer.
          const body =
            "event: message\ndata: " + JSON.stringify({ jsonrpc: "2.0", method: "notifications/message", params: {} }) + "\n\n" +
            "event: message\ndata: " + JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { tools: [{ name: "lookup" }] } }) + "\n\n"
          return new Response(body, { headers: { "content-type": "text/event-stream" } })
        }
        if (message.method === "tools/call") return json({ content: [{ type: "text", text: "found " + message.params.arguments.q }] })
        return Response.json({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "nope" } })
      },
    })
    return { server, seen, url: `http://127.0.0.1:${server.port}/mcp` }
  }

  test("the session id and protocol version travel with every request after initialize", async () => {
    const { server, seen, url } = remoteServer()
    try {
      const client = new McpClient("remote", { type: "remote", url, headers: { authorization: "Bearer test" }, enabled: true })
      await client.connect()
      expect(client.error).toBeUndefined()
      expect(client.tools.map((tool) => tool.name)).toEqual(["lookup"])
      expect(await client.callTool("lookup", { q: "goblins" })).toBe("found goblins")
      await client.close()

      const init = seen.find((each) => each.method === "initialize")!
      expect(init.session).toBeNull()
      expect(init.authorization).toBe("Bearer test")
      for (const each of seen.filter((entry) => entry.method !== "initialize" && entry.method !== "DELETE")) {
        expect([each.method, each.session, each.version]).toEqual([each.method, "sess-1", LATEST_PROTOCOL_VERSION])
      }
      // Closing ends the session on the server too.
      expect(seen.at(-1)).toMatchObject({ method: "DELETE", session: "sess-1" })
    } finally {
      server.stop(true)
    }
  })

  test("an HTTP error is reported straight away, not waited out", async () => {
    const { server, url } = remoteServer({ failInitialize: 401 })
    try {
      const client = new McpClient("remote", { type: "remote", url, headers: {}, enabled: true, timeout: 20_000 })
      const started = Date.now()
      await client.connect()
      expect(client.status).toBe("failed")
      expect(client.error).toContain("HTTP 401")
      expect(Date.now() - started).toBeLessThan(5000)
    } finally {
      server.stop(true)
    }
  })
})
