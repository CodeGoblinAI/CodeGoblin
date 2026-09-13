import fs from "node:fs"
import path from "node:path"
import { Global } from "../platform/paths"
import { runAgent, type AgentEvent, type ExtraTools, type Message, type Subagents } from "./agent"
import { parseFrontmatter } from "./frontmatter"
import type { Permissions } from "./permission"
import type { Provider } from "./providers"
import { systemPrompt, type Where } from "./system-prompt"
import type { History } from "./undo"

/**
 * Subagents: agents the main agent starts on a task and leaves running in the
 * background while it carries on.
 *
 * The main agent gets two tools. `task` starts one and returns at once;
 * `task_result` collects what it found, waiting if asked to. Anything left
 * uncollected when the main agent tries to finish is waited for and handed to
 * it, so a conversation never ends with its own work still out.
 *
 * A subagent starts with no context but the task, works under the
 * conversation's permissions - the same rules, mode, planning and approvals,
 * read live - and cannot start subagents of its own. Its tool calls reach the
 * surfaces as events, and its edits land in the same undo checkpoint as the
 * turn that started it.
 *
 * Two are built in: explore, which only reads, and general, which can do
 * anything the conversation can. More come from Markdown files in the same
 * places the fork and Claude Code keep theirs:
 *
 *   <project>/.codegoblin/agent(s), <project>/.claude/agents
 *   <config>/agent(s), ~/.claude/agents
 *
 * Not yet: a `model` in an agent file (subagents use the conversation's
 * model), and resuming a finished subagent.
 */

export type AgentProfile = {
  name: string
  description: string
  /** Built-in tool names it may use, plus "mcp" for MCP tools. Unset means everything. */
  tools?: string[]
  prompt: string
  source: "built-in" | "project" | "global"
  location?: string
}

/** Tools that only look. */
const READ_ONLY = ["read_file", "list_files", "grep", "glob", "skill", "webfetch"]

export const BUILT_IN_AGENTS: AgentProfile[] = [
  {
    name: "explore",
    description:
      "Reads and searches, and changes nothing - use it to find where something lives, how something works, or what calls what.",
    tools: READ_ONLY,
    prompt:
      "Find things out and report them. You can only read: there is no editing and no shell. Search broadly, then read what matters, and answer with specific file paths and line numbers.",
    source: "built-in",
  },
  {
    name: "general",
    description:
      "Can do anything the conversation can - use it for a separate piece of work: a change in another part of the code, or a long investigation.",
    prompt:
      "Carry out the task you were given from start to finish - investigate, change what needs changing, and check it - then report exactly what you did and what you found.",
    source: "built-in",
  },
]

/** Claude Code's tool names, so its agent files mean the same here. */
const CLAUDE_TOOLS: Record<string, string> = {
  read: "read_file",
  ls: "list_files",
  grep: "grep",
  glob: "glob",
  bash: "shell",
  edit: "edit_file",
  multiedit: "edit_file",
  write: "write_file",
  webfetch: "webfetch",
  websearch: "webfetch",
  todowrite: "todo_write",
  skill: "skill",
}
const OWN_TOOLS = new Set(["read_file", "list_files", "grep", "glob", "shell", "edit_file", "write_file", "webfetch", "todo_write", "skill"])

export function toolsFrom(value: unknown): string[] | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined
  const tools = new Set<string>()
  for (const word of value.split(/[\s,]+/).filter(Boolean)) {
    const lower = word.toLowerCase()
    if (OWN_TOOLS.has(lower)) tools.add(lower)
    else if (CLAUDE_TOOLS[lower]) tools.add(CLAUDE_TOOLS[lower]!)
    else if (lower === "mcp" || lower.startsWith("mcp__")) tools.add("mcp")
  }
  return [...tools]
}

function agentFiles(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.name.toLowerCase().endsWith(".md") && (entry.isFile() || entry.isSymbolicLink()))
      .map((entry) => path.join(dir, entry.name))
      .sort()
  } catch {
    return []
  }
}

/** Every agent a task can name: files first, so a project or the user can replace a built-in on purpose. */
export function listAgents(cwd: string = process.cwd()): AgentProfile[] {
  const home = Global.Path.home
  const global = [
    path.join(Global.Path.config, "agent"),
    path.join(Global.Path.config, "agents"),
    path.join(home, ".claude", "agents"),
  ]
  const same = new Set(global.map((dir) => path.resolve(dir).toLowerCase()))
  const project = [path.join(cwd, ".codegoblin", "agent"), path.join(cwd, ".codegoblin", "agents"), path.join(cwd, ".claude", "agents")].filter(
    (dir) => !same.has(path.resolve(dir).toLowerCase()),
  )
  const found = new Map<string, AgentProfile>()
  for (const [dirs, source] of [
    [project, "project"],
    [global, "global"],
  ] as const) {
    for (const dir of dirs) {
      for (const file of agentFiles(dir)) {
        let text: string
        try {
          text = fs.readFileSync(file, "utf8")
        } catch {
          continue
        }
        const { data, body } = parseFrontmatter(text)
        const name = (typeof data.name === "string" && data.name.trim()) || path.basename(file, path.extname(file))
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) || found.has(name)) continue
        const description = typeof data.description === "string" ? data.description.trim() : ""
        if (!description) continue
        const tools = toolsFrom(data.tools)
        found.set(name, { name, description, ...(tools ? { tools } : {}), prompt: body.trim(), source, location: file })
      }
    }
  }
  for (const agent of BUILT_IN_AGENTS) if (!found.has(agent.name)) found.set(agent.name, agent)
  return [...found.values()]
}

/** What a subagent needs from the conversation that starts it, read when the task starts. */
export type SubagentContext = {
  provider: Provider
  modelId: string
  apiKey: string
  root: string
  where: Where
  contextWindow?: number
  permissions?: Permissions
  history?: History
  /** MCP tools, for agents allowed them. */
  mcp?: ExtraTools
  instructions?: string
  memory?: string
  effort?: "low" | "medium" | "high"
}

export type TaskStatus = "running" | "done" | "failed" | "stopped"

export type SubagentEvent =
  | { type: "subagent_start"; task: string; agent: string; description: string }
  | { type: "subagent_event"; task: string; agent: string; event: AgentEvent }
  | { type: "subagent_end"; task: string; agent: string; status: TaskStatus; result: string }

type Task = {
  id: string
  agent: AgentProfile
  description: string
  status: TaskStatus
  result: string
  /** Whether the main agent has been given the result, one way or the other. */
  reported: boolean
  toolCalls: number
  controller: AbortController
  done: Promise<void>
}

const NEWLINE = String.fromCharCode(10)

const subagentNote = (name: string) =>
  [
    `You are the ${name} subagent. The main agent started you to do one task in the background, and`,
    "it reads your final answer - the user does not see your work directly and cannot answer questions",
    "from you. Work until the task is done, then reply once with what you found or changed, naming files.",
  ].join(" ")

export class SubagentManager implements Subagents {
  private tasks = new Map<string, Task>()
  private count = 0

  /**
   * `context` is read when a task starts, so it always has the conversation's
   * current model and permissions. `onEvent` can be replaced - the browser
   * sends events down whichever request is running now.
   */
  constructor(
    private context: () => SubagentContext,
    public onEvent: (event: SubagentEvent) => void = () => {},
  ) {}

  schema(): { type: "function"; function: { name: string; description: string; parameters: Record<string, unknown> } }[] {
    const agents = listAgents(this.context().root)
    return [
      {
        type: "function",
        function: {
          name: "task",
          description: [
            "Start a subagent on a task in the background, and keep working while it runs. Use one for work",
            "that can go on alongside yours, and give it everything it needs in the prompt - it starts with no",
            "context. Collect its result with task_result; results you have not collected are handed to you",
            "before you finish. Agents:",
            ...agents.map((agent) => `- ${agent.name}: ${agent.description}`),
          ].join(NEWLINE),
          parameters: {
            type: "object",
            properties: {
              agent: { type: "string", enum: agents.map((agent) => agent.name), description: "Which agent to start." },
              description: { type: "string", description: "A few words saying what it is for, shown to the user." },
              prompt: { type: "string", description: "The whole task: the context it needs, and what to report back." },
            },
            required: ["agent", "description", "prompt"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "task_result",
          description: "What a subagent you started has found. wait: true waits until it finishes; otherwise a running task says so.",
          parameters: {
            type: "object",
            properties: {
              id: { type: "string", description: "The id task gave back." },
              wait: { type: "boolean", description: "Wait for it to finish." },
            },
            required: ["id"],
          },
        },
      },
    ]
  }

  has(name: string): boolean {
    return name === "task" || name === "task_result"
  }

  async call(name: string, args: unknown): Promise<string> {
    const input = (args ?? {}) as Record<string, unknown>
    if (name === "task") return this.start(input)
    if (name === "task_result") return this.result(input)
    return `unknown tool: ${name}`
  }

  private start(input: Record<string, unknown>): string {
    const context = this.context()
    const agents = listAgents(context.root)
    const agent = agents.find((each) => each.name === input.agent)
    if (!agent) return `error: no agent named "${String(input.agent)}". Agents: ${agents.map((each) => each.name).join(", ")}`
    const prompt = String(input.prompt ?? "").trim()
    if (!prompt) return "error: a task needs a prompt saying what to do"
    const description = String(input.description ?? "").trim() || prompt.slice(0, 60)

    const id = "task-" + ++this.count
    const task: Task = {
      id,
      agent,
      description,
      status: "running",
      result: "",
      reported: false,
      toolCalls: 0,
      controller: new AbortController(),
      done: Promise.resolve(),
    }
    this.tasks.set(id, task)
    this.onEvent({ type: "subagent_start", task: id, agent: agent.name, description })
    task.done = this.run(task, context, prompt)
    return [
      `started ${id}: the ${agent.name} agent is working on "${description}" in the background.`,
      "Carry on with your own work. Collect its result with task_result (wait: true to wait for it);",
      "anything you have not collected is handed to you before you finish.",
    ].join(" ")
  }

  private async run(task: Task, context: SubagentContext, prompt: string): Promise<void> {
    const messages: Message[] = [
      {
        role: "system",
        content: [systemPrompt(context.where), "", subagentNote(task.agent.name), task.agent.prompt].filter(Boolean).join(NEWLINE),
      },
      { role: "user", content: prompt },
    ]
    try {
      for await (const event of runAgent({
        provider: context.provider,
        modelId: context.modelId,
        apiKey: context.apiKey,
        messages,
        root: context.root,
        contextWindow: context.contextWindow,
        permissions: context.permissions?.forSubagent(task.agent.name),
        history: context.history,
        extraTools: !task.agent.tools || task.agent.tools.includes("mcp") ? context.mcp : undefined,
        tools: task.agent.tools,
        instructions: context.instructions,
        memory: context.memory,
        effort: context.effort,
        signal: task.controller.signal,
      })) {
        if (event.type === "tool_start") task.toolCalls++
        this.onEvent({ type: "subagent_event", task: task.id, agent: task.agent.name, event })
      }
      const answer = [...messages].reverse().find((message) => message.role === "assistant" && message.content.trim())
      task.status = task.controller.signal.aborted ? "stopped" : "done"
      task.result = answer?.content.trim() || "(it finished without saying anything)"
    } catch (error) {
      task.status = task.controller.signal.aborted ? "stopped" : "failed"
      task.result = task.status === "stopped" ? "stopped before it finished" : "error: " + (error instanceof Error ? error.message : String(error))
    }
    this.onEvent({ type: "subagent_end", task: task.id, agent: task.agent.name, status: task.status, result: task.result })
  }

  private format(task: Task): string {
    return `<task_result id="${task.id}" agent="${task.agent.name}" status="${task.status}">${NEWLINE}${task.result}${NEWLINE}</task_result>`
  }

  private async result(input: Record<string, unknown>): Promise<string> {
    const task = this.tasks.get(String(input.id ?? ""))
    if (!task) return `error: no task "${String(input.id)}". Started: ${[...this.tasks.keys()].join(", ") || "none"}`
    if (task.status === "running" && input.wait === true) await task.done
    if (task.status === "running") return `${task.id} is still running (${task.toolCalls} tool calls so far).`
    task.reported = true
    return this.format(task)
  }

  /** Waits for every task not yet reported, and hands their results over - or nothing when there are none. */
  async settle(signal?: AbortSignal): Promise<string | undefined> {
    const waiting = [...this.tasks.values()].filter((task) => !task.reported)
    if (!waiting.length) return undefined
    let stop: (() => void) | undefined
    const aborted = new Promise<void>((done) => {
      stop = done
      signal?.addEventListener("abort", () => done(), { once: true })
    })
    await Promise.race([Promise.all(waiting.map((task) => task.done)), aborted])
    stop?.()
    if (signal?.aborted) {
      this.stopAll()
      return undefined
    }
    for (const task of waiting) task.reported = true
    return [
      "Background subagents you started have finished. Their results, which you have not seen yet:",
      "",
      ...waiting.map((task) => this.format(task)),
    ].join(NEWLINE)
  }

  running(): { id: string; agent: string; description: string; toolCalls: number }[] {
    return [...this.tasks.values()]
      .filter((task) => task.status === "running")
      .map((task) => ({ id: task.id, agent: task.agent.name, description: task.description, toolCalls: task.toolCalls }))
  }

  stopAll() {
    for (const task of this.tasks.values()) if (task.status === "running") task.controller.abort()
  }

  /** A new conversation: stop anything still running and forget the rest. */
  reset() {
    this.stopAll()
    this.tasks.clear()
  }
}
