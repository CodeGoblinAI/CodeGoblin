import { afterEach, describe, expect, test } from "bun:test"
import { runAgent, type AgentEvent } from "../src/core/agent"
import type { Provider } from "../src/core/providers"

/**
 * The agent loop, with the provider replaced.
 *
 * Nothing here reaches the network: fetch is swapped for a queue of canned
 * server-sent event streams, one per turn, so a loop that would otherwise
 * need a paid model and a tolerance for its mood becomes ordinary to test.
 */
const provider: Provider = {
  id: "test",
  label: "Test",
  baseUrl: "https://example.invalid/v1/chat/completions",
  models: [{ id: "test-model", label: "Test", contextWindow: 128000 }],
}

const NEWLINE = String.fromCharCode(10)

/** One SSE body from the chunks a provider would have streamed. */
function stream(...chunks: unknown[]): Response {
  const text =
    chunks.map((chunk) => "data: " + JSON.stringify(chunk)).join(NEWLINE + NEWLINE) +
    NEWLINE + NEWLINE + "data: [DONE]" + NEWLINE + NEWLINE
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(text))
        controller.close()
      },
    }),
    { status: 200 },
  )
}

const asksForATool = () =>
  stream({
    choices: [
      {
        delta: {
          tool_calls: [
            { index: 0, id: "call-1", function: { name: "list_files", arguments: '{"path":"."}' } },
          ],
        },
      },
    ],
  })

const answers = (text: string) => stream({ choices: [{ delta: { content: text } }] })

test("output exhaustion is surfaced and truncated tool calls never run", async () => {
  serve(() => stream({ choices: [{ delta: { tool_calls: [{ index: 0, id: "partial", function: { name: "list_files", arguments: '{"path":' } }] }, finish_reason: "length" }] }))
  const events = await collect(1)
  expect(events.some((event) => event.type === "output_limit")).toBe(true)
  expect(events.some((event) => event.type === "tool_start")).toBe(false)
  expect(events.at(-1)?.type).toBe("turn_end")
})

/** One assistant turn asking for several tools at once, the way the wire allows. */
const asksForMany = (...calls: { id: string; name: string; args: string }[]) => () =>
  stream({
    choices: [
      {
        delta: {
          tool_calls: calls.map((call, index) => ({
            index,
            id: call.id,
            function: { name: call.name, arguments: call.args },
          })),
        },
      },
    ],
  })

const reads = (path: string, id: string) => ({ id, name: "read_file", args: JSON.stringify({ path }) })

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

/** Serve the given responses in order, repeating the last one forever. */
function serve(...responses: (() => Response)[]) {
  let index = 0
  globalThis.fetch = (async () => {
    const make = responses[Math.min(index, responses.length - 1)]!
    index++
    return make()
  }) as typeof fetch

  return () => index
}

async function collect(maxTurns: number): Promise<AgentEvent[]> {
  const events: AgentEvent[] = []
  for await (const event of runAgent({
    provider,
    modelId: "test-model",
    apiKey: "not-a-real-key",
    messages: [{ role: "user", content: "go" }],
    root: process.cwd(),
    maxTurns,
  })) {
    events.push(event)
  }
  return events
}

describe("the turn limit", () => {
  test("a model that never stops calling tools ends with a limit event", async () => {
    const requests = serve(asksForATool)
    const events = await collect(3)

    const limit = events.find((event) => event.type === "limit")
    expect(limit).toBeDefined()
    expect(limit && "turns" in limit ? limit.turns : 0).toBe(3)
    // It asked three times and then gave up, rather than looping forever.
    expect(requests()).toBe(3)
  })

  test("the limit comes before turn_end, so a surface sees why it ended", async () => {
    serve(asksForATool)
    const types = (await collect(2)).map((event) => event.type)
    expect(types.indexOf("limit")).toBeLessThan(types.indexOf("turn_end"))
    expect(types[types.length - 1]).toBe("turn_end")
  })

  test("an answer that finishes on its own says nothing about limits", async () => {
    serve(() => answers("all done"))
    const events = await collect(8)

    expect(events.some((event) => event.type === "limit")).toBe(false)
    expect(events.some((event) => event.type === "text")).toBe(true)
    expect(events[events.length - 1]!.type).toBe("turn_end")
  })

  test("a turn that uses a tool and then answers is not a limit either", async () => {
    serve(asksForATool, () => answers("found them"))
    const events = await collect(8)

    expect(events.some((event) => event.type === "tool_start")).toBe(true)
    expect(events.some((event) => event.type === "tool_end")).toBe(true)
    expect(events.some((event) => event.type === "limit")).toBe(false)
  })

  test("with no limit set, a long run goes on until the model answers", async () => {
    // Real work stopped at eight turns, part way through checking a fix. There
    // is no default limit now: the model finishes by answering.
    const requests = serve(...Array.from({ length: 20 }, () => asksForATool), () => answers("finished"))
    const events: AgentEvent[] = []
    for await (const event of runAgent({
      provider,
      modelId: "test-model",
      apiKey: "not-a-real-key",
      messages: [{ role: "user", content: "go" }],
      root: process.cwd(),
    })) {
      events.push(event)
    }
    expect(requests()).toBe(21)
    expect(events.filter((event) => event.type === "tool_end").length).toBe(20)
    expect(events.some((event) => event.type === "limit")).toBe(false)
    expect(events[events.length - 1]!.type).toBe("turn_end")
  })
})

describe("several tools in one turn", () => {
  const threeReads = asksForMany(
    reads("package.json", "a"),
    reads("tsconfig.json", "b"),
    reads(".gitignore", "c"),
  )

  test("every row gets its own id, and every result names the row it belongs to", async () => {
    serve(threeReads, () => answers("done"))
    const events = await collect(8)

    const started = events.filter((e) => e.type === "tool_start") as { id: string }[]
    const ended = events.filter((e) => e.type === "tool_end") as { id: string }[]

    expect(started.map((e) => e.id)).toEqual(["a", "b", "c"])
    expect(new Set(started.map((e) => e.id)).size).toBe(3)
    // Matching a result to a row by id is the whole point; being last is not
    // a safe way to guess once these can overlap.
    expect(ended.map((e) => e.id)).toEqual(["a", "b", "c"])
  })

  test("results are reported in the order asked, not the order they finished", async () => {
    serve(threeReads, () => answers("done"))
    const events = await collect(8)

    const order = events.filter((e) => e.type === "tool_end").map((e) => ("id" in e ? e.id : ""))
    expect(order).toEqual(["a", "b", "c"])
  })

  test("all the rows open before any of them closes", async () => {
    serve(threeReads, () => answers("done"))
    const types = (await collect(8)).map((e) => e.type)
    const lastStart = types.lastIndexOf("tool_start")
    const firstEnd = types.indexOf("tool_end")
    expect(lastStart).toBeLessThan(firstEnd)
  })

  test("each result reaches the model against its own tool_call_id", async () => {
    serve(threeReads, () => answers("done"))
    const messages: { role: string; content: string; tool_call_id?: string }[] = [
      { role: "user", content: "go" },
    ]
    for await (const _ of runAgent({
      provider,
      modelId: "test-model",
      apiKey: "not-a-real-key",
      messages: messages as never,
      root: process.cwd(),
      maxTurns: 8,
    })) {
      // drained
    }
    const toolReplies = messages.filter((message) => message.role === "tool")
    expect(toolReplies.map((message) => message.tool_call_id)).toEqual(["a", "b", "c"])
    // package.json really was read, so these are results and not placeholders.
    expect(toolReplies[0]!.content).toContain("codegoblin")
  })

  test("consent is asked for every call before any of them runs", async () => {
    serve(threeReads, () => answers("done"))
    const asked: string[] = []
    const events: AgentEvent[] = []

    for await (const event of runAgent({
      provider,
      modelId: "test-model",
      apiKey: "not-a-real-key",
      messages: [{ role: "user", content: "go" }],
      root: process.cwd(),
      maxTurns: 8,
      // A stand-in rather than the real Permissions, which waves reads through
      // without consulting anything. This is about the loop asking whatever it
      // was given, in order, before anything starts.
      permissions: {
        mode: "ask",
        decide: async (name: string) => {
          // Nothing may have started while a question is still outstanding.
          expect(events.some((e) => e.type === "tool_start")).toBe(false)
          asked.push(name)
          return { allowed: true }
        },
      } as never,
    })) {
      events.push(event)
    }

    expect(asked).toEqual(["read_file", "read_file", "read_file"])
  })

  test("a refused call still answers the model, and the others still run", async () => {
    serve(threeReads, () => answers("done"))
    let seen = 0
    const events: AgentEvent[] = []

    for await (const event of runAgent({
      provider,
      modelId: "test-model",
      apiKey: "not-a-real-key",
      messages: [{ role: "user", content: "go" }],
      root: process.cwd(),
      maxTurns: 8,
      permissions: {
        mode: "ask",
        decide: async () =>
          ++seen !== 2 ? { allowed: true } : { allowed: false, by: "user", reason: "refused by the user" },
      } as never,
    })) {
      events.push(event)
    }

    const denied = events.filter((e) => e.type === "tool_denied") as { id: string; by: string }[]
    expect(denied.map((e) => e.id)).toEqual(["b"])
    // Whose decision it was travels with the event, so a surface can say so.
    expect(denied[0]!.by).toBe("user")

    const ended = events.filter((e) => e.type === "tool_end") as { id: string; result: string }[]
    expect(ended.map((e) => e.id)).toEqual(["a", "b", "c"])
    expect(ended[1]!.result).toContain("refused")
    expect(ended[0]!.result).not.toContain("refused")
  })

  test("a command a rule stops tells the model which rule, and never runs", async () => {
    // The real Permissions and a real deny rule, end to end. Telling the model
    // the user refused - when nobody was asked - sends it looking for the wrong
    // fix, and a blocked command must not have run at all.
    const { Permissions } = await import("../src/core/permission")
    const command = JSON.stringify({ command: "echo rm -rf nothing" })
    serve(asksForMany({ id: "x", name: "shell", args: command }), () => answers("ok"))
    const permissions = new Permissions(async () => "always", () => ({ "*rm -rf*": "deny" }))
    permissions.mode = "full"
    const messages: { role: string; content: string; tool_call_id?: string }[] = [{ role: "user", content: "go" }]

    const events: AgentEvent[] = []
    for await (const event of runAgent({
      provider,
      modelId: "test-model",
      apiKey: "not-a-real-key",
      messages: messages as never,
      root: process.cwd(),
      maxTurns: 8,
      permissions,
    })) {
      events.push(event)
    }

    // The surfaces label a blocked call from this event, so the rule rides on it.
    expect(events.find((event) => event.type === "tool_denied")).toMatchObject({ id: "x", by: "rule", rule: "*rm -rf*" })

    const reply = messages.find((message) => message.tool_call_id === "x")?.content ?? ""
    expect(reply).toContain('"*rm -rf*"')
    expect(reply).not.toContain("refused by the user")
    // echo would have printed its words; a blocked call has no output at all.
    expect(reply).not.toContain("rm -rf nothing")
  })
})

describe("which tools may overlap", () => {
  test("reads may, and everything that changes something may not", async () => {
    const { isConcurrent } = await import("../src/core/tools")
    for (const name of ["read_file", "list_files", "grep", "glob"]) {
      expect(isConcurrent(name)).toBe(true)
    }
    // A write can contend for a path, shell can do anything, todo_write moves
    // shared state, and webfetch asks about each new host.
    for (const name of ["write_file", "edit_file", "shell", "todo_write", "webfetch"]) {
      expect(isConcurrent(name)).toBe(false)
    }
  })

  test("a name nobody knows is not assumed safe", async () => {
    const { isConcurrent } = await import("../src/core/tools")
    expect(isConcurrent("rm_minus_rf")).toBe(false)
  })
})

describe("how a provider's key is presented", () => {
  /** Capture what the loop actually put on the wire. */
  async function headersSentBy(which: Provider): Promise<Record<string, string>> {
    let sent: Record<string, string> = {}
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      sent = init.headers as Record<string, string>
      return answers("ok")
    }) as unknown as typeof fetch

    for await (const _ of runAgent({
      provider: which,
      modelId: "test-model",
      apiKey: "sk-secret",
      messages: [{ role: "user", content: "go" }],
      root: process.cwd(),
      maxTurns: 1,
    })) {
      // drained
    }
    return sent
  }

  test("a provider that says nothing gets a bearer token", async () => {
    const sent = await headersSentBy(provider)
    expect(sent.authorization).toBe("Bearer sk-secret")
  })

  test("a provider can ask for its key somewhere else entirely", async () => {
    const sent = await headersSentBy({
      ...provider,
      auth: (key) => ({ "x-api-key": key, "anthropic-version": "2023-06-01" }),
    })

    expect(sent["x-api-key"]).toBe("sk-secret")
    expect(sent["anthropic-version"]).toBe("2023-06-01")
    // And the bearer header is gone, not merely joined - a provider that
    // rejects unknown auth headers would fail on the leftover.
    expect(sent.authorization).toBeUndefined()
  })

  test("the content type survives whatever the provider asks for", async () => {
    const sent = await headersSentBy({ ...provider, auth: (key) => ({ "x-api-key": key }) })
    expect(sent["content-type"]).toBe("application/json")
  })
})

describe("showing a model a picture", () => {
  const PICTURE = { name: "shot.png", dataUrl: "data:image/png;base64,AAAA" }

  /** What the loop actually put in the request body. */
  async function bodySentWith(images: boolean): Promise<any> {
    let body: any
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      body = JSON.parse(String(init.body))
      return answers("ok")
    }) as unknown as typeof fetch

    for await (const _ of runAgent({
      provider,
      modelId: "test-model",
      apiKey: "k",
      messages: [{ role: "user", content: "what is this", images: [PICTURE] }],
      root: process.cwd(),
      maxTurns: 1,
      images,
    })) {
      // drained
    }
    return body
  }

  test("a vision model gets the picture in the shape it reads", async () => {
    const body = await bodySentWith(true)
    const content = body.messages.find((message: { role: string }) => message.role === "user").content

    expect(Array.isArray(content)).toBe(true)
    expect(content[0]).toEqual({ type: "text", text: "what is this" })
    // The picture is named and said to be in view, so a model with tools does not go and open the file instead.
    expect(content[1].type).toBe("text")
    expect(content[1].text).toContain(PICTURE.name)
    expect(content[1].text).toContain("you can see directly")
    expect(content[2]).toEqual({ type: "image_url", image_url: { url: PICTURE.dataUrl } })
  })

  test("a model that cannot see is told one was attached, and not sent it", async () => {
    const body = await bodySentWith(false)
    const content = body.messages.find((message: { role: string }) => message.role === "user").content

    expect(typeof content).toBe("string")
    expect(content).toContain("what is this")
    expect(content).toContain("shot.png")
    expect(content).toContain("cannot see images")
    // The bytes must not go out to a model that has no use for them.
    expect(JSON.stringify(body)).not.toContain(PICTURE.dataUrl)
  })

  test("a message with no picture is unchanged either way", async () => {
    for (const images of [true, false]) {
      globalThis.fetch = (async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body))
        expect(body.messages.find((message: { role: string }) => message.role === "user").content).toBe("plain")
        return answers("ok")
      }) as unknown as typeof fetch

      for await (const _ of runAgent({
        provider,
        modelId: "test-model",
        apiKey: "k",
        messages: [{ role: "user", content: "plain" }],
        root: process.cwd(),
        maxTurns: 1,
        images,
      })) {
        // drained
      }
    }
  })

  test("memory still reaches the system prompt when a picture is present", async () => {
    let body: any
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      body = JSON.parse(String(init.body))
      return answers("ok")
    }) as unknown as typeof fetch

    for await (const _ of runAgent({
      provider,
      modelId: "test-model",
      apiKey: "k",
      messages: [
        { role: "system", content: "you are a goblin" },
        { role: "user", content: "what is this", images: [PICTURE] },
      ],
      root: process.cwd(),
      maxTurns: 1,
      images: true,
      memory: "remember: the user likes brevity",
    })) {
      // drained
    }

    expect(body.messages[0].content).toContain("you are a goblin")
    expect(body.messages[0].content).toContain("likes brevity")
  })
})

describe("which models can be shown one", () => {
  test("the vision model can, and the others cannot", async () => {
    const { acceptsImages, resolveSelection } = await import("../src/core/providers")

    expect(acceptsImages(resolveSelection("deepseek/deepseek-v4-flash-vision-exp")!)).toBe(true)
    expect(acceptsImages(resolveSelection("deepseek/deepseek-v4-flash")!)).toBe(false)
  })

  test("a generator's reference image is not the same claim", async () => {
    const { acceptsImages, resolveSelection } = await import("../src/core/providers")

    // These declare input.image too, meaning "takes a picture and makes one" -
    // which is the opposite direction and not a conversation at all.
    expect(acceptsImages(resolveSelection("google/gemini-2.5-flash-image")!)).toBe(false)
    expect(acceptsImages(resolveSelection("tripo/image-to-model")!)).toBe(false)
  })

  test("declaring image input does not move a model out of the text section", async () => {
    const { kindOf, resolveSelection } = await import("../src/core/providers")
    expect(kindOf(resolveSelection("deepseek/deepseek-v4-flash-vision-exp")!.model)).toBe("text")
  })
})

describe("reasoning effort on the wire", () => {
  /** What the loop actually posted. */
  async function bodySentWith(effort?: "low" | "medium" | "high"): Promise<Record<string, unknown>> {
    let sent: Record<string, unknown> = {}
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      sent = JSON.parse(String(init.body))
      return answers("ok")
    }) as unknown as typeof fetch

    for await (const _ of runAgent({
      provider,
      modelId: "test-model",
      apiKey: "k",
      messages: [{ role: "user", content: "go" }],
      root: process.cwd(),
      maxTurns: 1,
      effort,
    })) {
      // drained
    }
    return sent
  }

  test("a level given reaches the request", async () => {
    expect((await bodySentWith("high")).reasoning_effort).toBe("high")
    expect((await bodySentWith("low")).reasoning_effort).toBe("low")
  })

  test("no level means the field is absent, not empty", async () => {
    const body = await bodySentWith(undefined)
    expect("reasoning_effort" in body).toBe(false)
  })

  test("the rest of the request is unchanged either way", async () => {
    const body = await bodySentWith("medium")
    expect(body.model).toBe("test-model")
    expect(body.stream).toBe(true)
    expect(Array.isArray(body.tools)).toBe(true)
  })
})

describe("the loop itself", () => {
  test("a refusal from the provider is raised, not swallowed", async () => {
    globalThis.fetch = (async () => new Response("no key for you", { status: 401 })) as typeof fetch
    await expect(collect(2)).rejects.toThrow(/401/)
  })

  test("an aborted turn stops asking", async () => {
    const requests = serve(asksForATool)
    const stopping = new AbortController()
    const events: AgentEvent[] = []

    for await (const event of runAgent({
      provider,
      modelId: "test-model",
      apiKey: "not-a-real-key",
      messages: [{ role: "user", content: "go" }],
      root: process.cwd(),
      maxTurns: 8,
      signal: stopping.signal,
    })) {
      events.push(event)
      if (event.type === "tool_end") stopping.abort()
    }

    expect(requests()).toBeLessThan(8)
    expect(events.some((event) => event.type === "limit")).toBe(false)
  })
})

describe("tools from outside the built-in table", () => {
  const echo = () => {
    const called: unknown[] = []
    return {
      called,
      tools: {
        schema: () => [
          {
            type: "function" as const,
            function: { name: "mcp__fixture__echo", description: "Say it back.", parameters: { type: "object", properties: {} } },
          },
        ],
        has: (name: string) => name === "mcp__fixture__echo",
        call: async (_name: string, args: unknown) => {
          called.push(args)
          return "echo: hi"
        },
      },
    }
  }

  function scripted(bodies: { tools: { function: { name: string } }[] }[]) {
    let turn = 0
    globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
      bodies.push(JSON.parse(String(init?.body ?? "{}")))
      turn++
      return turn === 1 ? asksForMany({ id: "m1", name: "mcp__fixture__echo", args: JSON.stringify({ text: "hi" }) })() : answers("done")
    }) as unknown as typeof fetch
  }

  test("are offered to the model, asked about, and a call reaches them", async () => {
    const bodies: { tools: { function: { name: string } }[] }[] = []
    scripted(bodies)
    const { called, tools } = echo()
    const asked: string[] = []
    const { Permissions } = await import("../src/core/permission")
    const permissions = new Permissions(async (tool) => {
      asked.push(tool)
      return "once"
    })

    const events: AgentEvent[] = []
    for await (const event of runAgent({
      provider,
      modelId: "test-model",
      apiKey: "not-a-real-key",
      messages: [{ role: "user", content: "go" }],
      root: process.cwd(),
      maxTurns: 4,
      permissions,
      extraTools: tools,
    })) {
      events.push(event)
    }

    const offered = bodies[0]!.tools.map((tool) => tool.function.name)
    expect(offered).toContain("mcp__fixture__echo")
    expect(offered).toContain("read_file")
    expect(asked).toEqual(["mcp__fixture__echo"])
    expect(called).toEqual([{ text: "hi" }])
    expect(events.find((event) => event.type === "tool_end")).toMatchObject({ name: "mcp__fixture__echo", result: "echo: hi" })
  })

  test("a refused call never reaches the server", async () => {
    scripted([])
    const { called, tools } = echo()
    const { Permissions } = await import("../src/core/permission")
    for await (const _ of runAgent({
      provider,
      modelId: "test-model",
      apiKey: "not-a-real-key",
      messages: [{ role: "user", content: "go" }],
      root: process.cwd(),
      maxTurns: 4,
      permissions: new Permissions(async () => "reject"),
      extraTools: tools,
    })) {
      // drained
    }
    expect(called).toEqual([])
  })
})

describe("planning", () => {
  test("offers no tool that changes files, no MCP tools, and tells the model it is planning", async () => {
    const bodies: { tools: { function: { name: string } }[]; messages: { role: string; content: unknown }[] }[] = []
    globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
      bodies.push(JSON.parse(String(init?.body ?? "{}")))
      return answers("1. do the thing")
    }) as unknown as typeof fetch
    const { Permissions } = await import("../src/core/permission")
    const permissions = new Permissions(async () => "once")
    permissions.planning = true
    const extraTools = {
      schema: () => [{ type: "function" as const, function: { name: "mcp__x__y", description: "", parameters: {} } }],
      has: () => false,
      call: async () => "",
    }

    for await (const _ of runAgent({
      provider,
      modelId: "test-model",
      apiKey: "not-a-real-key",
      messages: [
        { role: "system", content: "base" },
        { role: "user", content: "plan it" },
      ],
      root: process.cwd(),
      maxTurns: 2,
      permissions,
      extraTools,
    })) {
      // drained
    }

    const offered = bodies[0]!.tools.map((tool) => tool.function.name)
    expect(offered).toContain("read_file")
    expect(offered).toContain("shell")
    expect(offered).not.toContain("write_file")
    expect(offered).not.toContain("edit_file")
    expect(offered).not.toContain("mcp__x__y")
    expect(String(bodies[0]!.messages[0]!.content)).toContain("Planning is on")
  })
})

describe("local usage", () => {
  test("local turns ask for stream usage so spend is recorded; hosted turns send nothing extra", async () => {
    const bodies: Record<string, unknown>[] = []
    const local: Provider = {
      id: "local", label: "Local", baseUrl: "http://127.0.0.1:1/v1/chat/completions", local: true,
      auth: () => ({}),
      models: [{ id: "fixture", label: "fixture", contextWindow: 4096, price: { input: 0, output: 0 } }],
    }
    globalThis.fetch = (async (url: unknown, init?: { body?: string }) => {
      if (String(url).endsWith("/models")) return Response.json({ data: [{ id: "fixture" }] })
      bodies.push(JSON.parse(String(init?.body ?? "{}")))
      return answers("done")
    }) as unknown as typeof fetch
    for await (const _ of runAgent({
      provider: local, modelId: "fixture", apiKey: "",
      messages: [{ role: "user", content: "hi" }],
      root: process.cwd(), maxTurns: 1,
    })) {
      // drained
    }
    expect(bodies).toHaveLength(1)
    expect(bodies[0]!.stream_options).toEqual({ include_usage: true })

    bodies.length = 0
    globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
      bodies.push(JSON.parse(String(init?.body ?? "{}")))
      return answers("done")
    }) as unknown as typeof fetch
    for await (const _ of runAgent({
      provider, modelId: "test-model", apiKey: "not-a-real-key",
      messages: [{ role: "user", content: "hi" }],
      root: process.cwd(), maxTurns: 1,
    })) {
      // drained
    }
    expect(bodies).toHaveLength(1)
    expect(bodies[0]!).not.toHaveProperty("stream_options")
  })
})

describe("autonomy checkpoints", () => {
  const twoReads = () => asksForMany(
    { id: "c1", name: "list_files", args: '{"path":"."}' },
    { id: "c2", name: "list_files", args: '{"path":"."}' },
  )()

  async function run(ask: () => Promise<"once" | "always" | "reject">, turns: (() => Response)[]) {
    const served = serve(...turns)
    const { Permissions } = await import("../src/core/permission")
    const events: AgentEvent[] = []
    for await (const event of runAgent({
      provider, modelId: "test-model", apiKey: "not-a-real-key",
      messages: [{ role: "user", content: "go" }],
      root: process.cwd(), maxTurns: 5,
      permissions: new Permissions(ask),
      checkpoint: 2,
    })) events.push(event)
    return { events, calls: served() }
  }

  test("a rejection stops the turn at the window", async () => {
    const { events, calls } = await run(async () => "reject", [twoReads, () => answers("done")])
    expect(events.filter((event) => event.type === "checkpoint")).toEqual([
      { type: "checkpoint", toolCalls: 2, stopped: true },
    ])
    expect(events.at(-1)?.type).toBe("turn_end")
    expect(calls).toBe(1)
  })

  test("continuing asks again after another full window", async () => {
    let asked = 0
    const { events, calls } = await run(async () => { asked++; return "once" }, [twoReads, twoReads, () => answers("done")])
    expect(events.filter((event) => event.type === "checkpoint")).toEqual([
      { type: "checkpoint", toolCalls: 2, stopped: false },
      { type: "checkpoint", toolCalls: 4, stopped: false },
    ])
    expect(events.at(-1)?.type).toBe("turn_end")
    expect(asked).toBe(2)
    expect(calls).toBe(3)
  })

  test("for-this-session disables later windows", async () => {
    let asked = 0
    const { events, calls } = await run(async () => { asked++; return "always" }, [twoReads, twoReads, () => answers("done")])
    expect(events.filter((event) => event.type === "checkpoint")).toEqual([
      { type: "checkpoint", toolCalls: 2, stopped: false },
    ])
    expect(asked).toBe(1)
    expect(calls).toBe(3)
  })

  test("with nobody to ask, the turn carries on", async () => {
    const served = serve(twoReads, () => answers("done"))
    const events: AgentEvent[] = []
    for await (const event of runAgent({
      provider, modelId: "test-model", apiKey: "not-a-real-key",
      messages: [{ role: "user", content: "go" }],
      root: process.cwd(), maxTurns: 3,
    })) events.push(event)
    expect(events.some((event) => event.type === "checkpoint")).toBe(false)
    expect(events.at(-1)?.type).toBe("turn_end")
    expect(served()).toBe(2)
  })
})

describe("compacting a long conversation", () => {
  test("archives what it replaces, counts the summary's spend, and sends only what fits", async () => {
    // Far bigger than the 4,000-token window: compaction must run first.
    const history = Array.from({ length: 300 }, (_, index) => ({ role: index % 2 ? "assistant" as const : "user" as const, content: "word ".repeat(80) + index }))
    const bodies: string[] = []
    let call = 0
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      bodies.push(String(init.body))
      call++
      if (call === 1) return new Response(JSON.stringify({ choices: [{ message: { content: "the gist" } }], usage: { prompt_tokens: 1900, completion_tokens: 12 } }))
      return stream({ choices: [{ delta: { content: "answer" } }] })
    }) as typeof fetch
    const archived: unknown[][] = []
    const events: AgentEvent[] = []
    for await (const event of runAgent({
      provider: { ...provider, models: [{ id: "test-model", label: "Test", contextWindow: 4000 }] },
      modelId: "test-model",
      apiKey: "not-a-real-key",
      messages: [...history, { role: "user", content: "and now?" }],
      root: process.cwd(),
      contextWindow: 4000,
      archive: async (messages) => { archived.push(messages) },
    })) events.push(event)
    const summaryRequest = JSON.parse(bodies[0]!)
    // The summary request fits the window instead of carrying all 300 messages.
    expect(summaryRequest.messages.length).toBeLessThan(100)
    expect(JSON.stringify(summaryRequest.messages)).toContain("earlier messages are kept in the saved transcript")
    expect(archived.length).toBe(1)
    expect(archived[0]!.length).toBeGreaterThan(250)
    expect(events.find((event) => event.type === "spend")).toEqual({ type: "spend", input: 1900, output: 12 })
    expect(events.some((event) => event.type === "compacted")).toBe(true)
  })
})
