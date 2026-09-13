import { afterEach, beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { runAgent, type AgentEvent, type Message } from "../src/core/agent"
import { Permissions } from "../src/core/permission"
import type { Provider } from "../src/core/providers"
import { Global } from "../src/platform/paths"
import { SubagentManager, listAgents, toolsFrom, type SubagentEvent } from "../src/core/subagents"
import { requireSandbox } from "./sandbox"

/**
 * Subagents against a scripted provider. Each request is answered by looking
 * at who is asking - the main agent, or a subagent, whose system prompt names
 * it - and how far into its own conversation it is.
 */
const provider: Provider = {
  id: "test",
  label: "Test",
  baseUrl: "https://example.invalid/v1/chat/completions",
  models: [{ id: "test-model", label: "Test", contextWindow: 128000 }],
}
const NEWLINE = String.fromCharCode(10)

function sse(delta: Record<string, unknown>): Response {
  const text = "data: " + JSON.stringify({ choices: [{ delta }] }) + NEWLINE + NEWLINE + "data: [DONE]" + NEWLINE + NEWLINE
  return new Response(text, { status: 200 })
}
const say = (content: string) => sse({ content })
const call = (id: string, name: string, args: unknown) =>
  sse({ tool_calls: [{ index: 0, id, function: { name, arguments: JSON.stringify(args) } }] })

type Body = { messages: { role: string; content: string }[]; tools: { function: { name: string } }[] }
type Script = {
  main: (step: number, body: Body) => Response
  sub: (step: number, body: Body, agent: string, signal?: AbortSignal) => Response
}

const bodies: Body[] = []
function script(handlers: Script) {
  bodies.length = 0
  globalThis.fetch = (async (_url: unknown, init?: { body?: string; signal?: AbortSignal }) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Body
    bodies.push(body)
    const system = String(body.messages[0]?.content ?? "")
    const agent = /You are the (\S+) subagent/.exec(system)?.[1]
    const step = body.messages.filter((message) => message.role === "assistant").length
    return agent ? handlers.sub(step, body, agent, init?.signal) : handlers.main(step, body)
  }) as unknown as typeof fetch
}

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

const home = Global.Path.home
let project = ""
beforeAll(() => {
  requireSandbox(path.join(home, ".claude", "agents", "probe.md"), "the subagent tests")
  project = fs.mkdtempSync(path.join(home, "subagents-"))
  fs.writeFileSync(path.join(project, "notes.txt"), "sum lives in math.js")
  fs.mkdirSync(path.join(home, ".claude", "agents"), { recursive: true })
  fs.writeFileSync(
    path.join(home, ".claude", "agents", "reviewer.md"),
    "---\nname: reviewer\ndescription: Reviews code and reports problems\ntools: Read, Grep, Glob\n---\nReview carefully.",
  )
  fs.mkdirSync(path.join(project, ".claude", "agents"), { recursive: true })
  fs.writeFileSync(path.join(project, ".claude", "agents", "explore.md"), "---\ndescription: The project's own explorer\n---\nProject rules.")
})

function manager(permissions?: Permissions, events: SubagentEvent[] = []) {
  return new SubagentManager(
    () => ({ provider, modelId: "test-model", apiKey: "not-a-real-key", root: project, where: "terminal", permissions }),
    (event) => events.push(event),
  )
}

async function drive(subagents: SubagentManager, permissions?: Permissions, signal?: AbortSignal) {
  const messages: Message[] = [
    { role: "system", content: "main" },
    { role: "user", content: "go" },
  ]
  const events: AgentEvent[] = []
  for await (const event of runAgent({ provider, modelId: "test-model", apiKey: "not-a-real-key", messages, root: project, permissions, subagents, signal })) {
    events.push(event)
  }
  return { messages, events }
}

describe("starting a subagent", () => {
  test("runs in the background, and its uncollected result is handed over before the main agent finishes", async () => {
    script({
      main: (step) =>
        step === 0
          ? call("t1", "task", { agent: "general", description: "find sum", prompt: "Where is sum defined?" })
          : step === 1
            ? say("I have started a subagent.")
            : say("Done: sum lives in math.js."),
      sub: (step) => (step === 0 ? call("r1", "read_file", { path: "notes.txt" }) : say("sum lives in math.js")),
    })
    const events: SubagentEvent[] = []
    const { messages, events: main } = await drive(manager(undefined, events))

    const started = main.find((event) => event.type === "tool_end" && event.name === "task") as { result: string }
    expect(started.result).toContain("started task-1")
    // The subagent's own tool call reached the surfaces as an event.
    expect(events.some((event) => event.type === "subagent_event" && event.event.type === "tool_start" && event.event.name === "read_file")).toBe(true)
    expect(events.at(-1)).toMatchObject({ type: "subagent_end", task: "task-1", agent: "general", status: "done", result: "sum lives in math.js" })
    // Handed to the main agent, which carried on and answered with it.
    const handed = messages.find((message) => message.role === "user" && message.content.includes("<task_result"))
    expect(handed?.content).toContain('agent="general" status="done"')
    expect(main.some((event) => event.type === "subagents_collected")).toBe(true)
    expect(messages.at(-1)).toMatchObject({ role: "assistant", content: "Done: sum lives in math.js." })
  })

  test("a result collected with task_result is not handed over a second time", async () => {
    script({
      main: (step) =>
        step === 0
          ? call("t1", "task", { agent: "explore", description: "look", prompt: "Look around." })
          : step === 1
            ? call("t2", "task_result", { id: "task-1", wait: true })
            : say("All done."),
      sub: () => say("nothing unusual"),
    })
    const { messages, events } = await drive(manager())
    const collected = events.find((event) => event.type === "tool_end" && event.name === "task_result") as { result: string }
    expect(collected.result).toContain("nothing unusual")
    expect(events.some((event) => event.type === "subagents_collected")).toBe(false)
    expect(messages.filter((message) => message.content.includes("<task_result")).length).toBe(1)
  })

  test("the main agent is offered task and task_result, and a subagent is not", async () => {
    script({
      main: (step) => (step === 0 ? call("t1", "task", { agent: "general", description: "x", prompt: "x" }) : say("ok")),
      sub: () => say("done"),
    })
    await drive(manager())
    const mainTools = bodies.find((body) => !String(body.messages[0]?.content).includes("subagent"))!.tools.map((tool) => tool.function.name)
    const subTools = bodies.find((body) => String(body.messages[0]?.content).includes("subagent"))!.tools.map((tool) => tool.function.name)
    expect(mainTools).toEqual(expect.arrayContaining(["task", "task_result"]))
    expect(subTools).not.toContain("task")
  })

  test("the task tool tells the model most tasks do not need a subagent", () => {
    // Subagents cost a second conversation's tokens; they are for big or
    // parallel work, not the default way to get something done.
    const task = manager().schema().find((tool) => tool.function.name === "task")!
    expect(task.function.description).toContain("Most tasks do not need one")
    expect(task.function.description).toContain("do the work yourself")
  })

  test("an agent name nobody defined is an error that lists the real ones", async () => {
    const result = await manager().call("task", { agent: "wizard", description: "x", prompt: "x" })
    expect(result).toContain('no agent named "wizard"')
    expect(result).toContain("general")
  })
})

describe("what a subagent may do", () => {
  test("explore is not offered anything that changes files, and a write it tries is refused unasked", async () => {
    let asked = 0
    const permissions = new Permissions(async () => {
      asked++
      return "once"
    })
    script({
      main: (step) =>
        step === 0 ? call("t1", "task", { agent: "reviewer", description: "review", prompt: "Review it." }) : say("ok"),
      sub: (step) => (step === 0 ? call("w1", "write_file", { path: "planted.txt", content: "x" }) : say("could not write")),
    })
    const events: SubagentEvent[] = []
    await drive(manager(permissions, events), permissions)

    const subBody = bodies.find((body) => String(body.messages[0]?.content).includes("reviewer subagent"))!
    expect(subBody.tools.map((tool) => tool.function.name).sort()).toEqual(["glob", "grep", "read_file"])
    const refused = events.find((event) => event.type === "subagent_event" && event.event.type === "tool_end") as { event: { result: string } }
    expect(refused.event.result).toContain("not available to this agent")
    expect(fs.existsSync(path.join(project, "planted.txt"))).toBe(false)
    expect(asked).toBe(0)
  })

  test("a subagent's question names it, and an approval it gets holds for the conversation", async () => {
    const heard: string[] = []
    const permissions = new Permissions(async (tool, _detail, _cover, from) => {
      heard.push((from ?? "main") + " " + tool)
      return "always"
    })
    const child = permissions.forSubagent("general")
    expect(await child.check("shell", JSON.stringify({ command: "git status" }))).toBe(true)
    expect(heard).toEqual(["general shell"])
    // Approved for the conversation, so the main agent is not asked again.
    expect(await permissions.check("shell", JSON.stringify({ command: "git status --short" }))).toBe(true)
    expect(heard.length).toBe(1)
  })

  test("a subagent follows the conversation's mode and planning as they change", async () => {
    const permissions = new Permissions(async () => "reject")
    const child = permissions.forSubagent("general")
    permissions.mode = "full"
    expect(await child.check("write_file", "{}")).toBe(true)
    permissions.planning = true
    expect(await child.check("write_file", "{}")).toBe(false)
  })
})

describe("stopping", () => {
  test("stopping the main turn stops a subagent it was waiting on", async () => {
    const controller = new AbortController()
    const events: SubagentEvent[] = []
    script({
      main: (step) => (step === 0 ? call("t1", "task", { agent: "general", description: "slow", prompt: "x" }) : say("waiting")),
      sub: (_step, _body, _agent, signal) => {
        // Never answers; like a real fetch, its body fails once the request is aborted.
        setTimeout(() => controller.abort(), 50)
        return new Response(
          new ReadableStream({
            start(stream) {
              signal?.addEventListener("abort", () => stream.error(new DOMException("aborted", "AbortError")))
            },
          }),
          { status: 200 },
        )
      },
    })
    await drive(manager(undefined, events), undefined, controller.signal)
    await new Promise((done) => setTimeout(done, 50))
    expect(events.find((event) => event.type === "subagent_end")).toMatchObject({ status: "stopped" })
  })
})

describe("agent files", () => {
  test("Claude Code's tool names mean the same tools here", () => {
    expect(toolsFrom("Read, Grep, Glob, Bash, Edit, WebFetch")).toEqual(["read_file", "grep", "glob", "shell", "edit_file", "webfetch"])
    expect(toolsFrom("read_file mcp__github__search")).toEqual(["read_file", "mcp"])
    expect(toolsFrom(undefined)).toBeUndefined()
  })

  test("are found, and a project's own file replaces a built-in of the same name", () => {
    const agents = listAgents(project)
    const reviewer = agents.find((agent) => agent.name === "reviewer")!
    expect(reviewer).toMatchObject({ source: "global", tools: ["read_file", "grep", "glob"], prompt: "Review carefully." })
    expect(agents.find((agent) => agent.name === "explore")).toMatchObject({ source: "project", description: "The project's own explorer" })
    expect(agents.find((agent) => agent.name === "general")?.source).toBe("built-in")
  })
})
