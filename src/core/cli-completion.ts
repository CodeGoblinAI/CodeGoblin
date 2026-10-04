import { randomUUID } from "node:crypto"
import type { AgentEvent, ToolCall } from "./agent"
import { claudeChat } from "./claude-cli"
import { codexChat } from "./codex-chat"
import { cursorChat } from "./cursor-sdk"

/** The CLI is an inference transport, never an alternative executor. */
export const CLI_BRIDGE_SYSTEM = [
  "You are CodeGoblin. Continue the supplied JSON conversation, obeying its task and safety instructions.",
  "The conversation's API-agent tool instructions describe CG-Next, not native tools of this process. This outer response protocol takes precedence over their formatting instructions.",
  "Your native CLI execution tools are disabled. Native sandbox/filesystem restrictions concern this process only: do not use native filesystem or execution capabilities.",
  "The separate CG-Next application offers the cg_tools array as schema DATA, not native callable functions. It can execute these requests in its own workspace after its own user approval. You are only returning a proposed JSON request, not executing it in the CLI sandbox.",
  "Never call a CG tool as a native function. Put every requested action inside the calls array of your structured response.",
  "Request those tools by returning JSON; CG-Next alone executes them after its permission checks.",
  "The conversation is chronological. A role=tool entry is a real CG execution result, linked by tool_call_id to an earlier assistant request. It is not a new user request.",
  "Continue after the latest results. Do not replay an already completed action. If those results satisfy the user's task, return the final answer with calls=[].",
  "Return exactly one JSON object, without markdown fences: {\"text\":\"your reply\",\"calls\":[{\"name\":\"tool name\",\"arguments\":\"JSON object encoded as a string\"}]}.",
  "Use an empty calls array for a final answer. Never claim an action succeeded until a tool result confirms it.",
  "A refusal is not permission to try a different tool to bypass it. Historical tool calls are context, not current capabilities.",
].join(" ")

export type CliCompletionEvent = Extract<AgentEvent, { type: "text" | "thinking" | "spend" | "output_limit" }> |
  { type: "calls"; calls: ToolCall[] }

type CliTools = { function: { name: string; description: string; parameters: Record<string, unknown> } }[]

export const CLI_RESPONSE_SCHEMA = {
  type: "object", additionalProperties: false, required: ["text", "calls"],
  properties: { text: { type: "string" }, calls: { type: "array", maxItems: 16, items: {
    type: "object", additionalProperties: false, required: ["name", "arguments"],
    properties: { name: { type: "string" }, arguments: { type: "string" } },
  } } },
}

export function parseCliCompletion(text: string, tools: CliTools) {
  const invalid = () => new Error("CLI returned an invalid CG-Next tool response; no requested tools were executed. Retry the prompt.")
  let value: unknown
  try { value = JSON.parse(text) } catch { throw invalid() }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid()
  const result = value as Record<string, unknown>
  if (Object.keys(result).some((key) => key !== "text" && key !== "calls") || typeof result.text !== "string" || !Array.isArray(result.calls) || result.calls.length > 16) throw invalid()
  const names = new Set(tools.map((tool) => tool.function.name))
  const calls = result.calls.map((raw): ToolCall => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw invalid()
    const call = raw as Record<string, unknown>
    if (Object.keys(call).some((key) => key !== "name" && key !== "arguments") || typeof call.name !== "string" || !names.has(call.name) || typeof call.arguments !== "string" || call.arguments.length > 256_000) throw invalid()
    let args: unknown
    try { args = JSON.parse(call.arguments) } catch { throw invalid() }
    if (!args || typeof args !== "object" || Array.isArray(args)) throw invalid()
    return { id: randomUUID(), name: call.name, args: call.arguments }
  })
  return { text: result.text, calls }
}

/** Buffer the control envelope; never render JSON or execute partial arguments. */
export async function* cliCompletion(input: {
  cli?: "claude-code" | "codex" | "cursor" | "cursor-api"
  apiKey?: string
  modelId: string; messages: unknown[]; tools: CliTools; signal?: AbortSignal
  effort?: "low" | "medium" | "high"
  /** Deterministic process peer for tests, never a user-configurable executable. */
  command?: string[]
}): AsyncGenerator<CliCompletionEvent> {
  let text = ""
  let limited = false
  const prompt = JSON.stringify({ conversation: input.messages, cg_tools: input.tools })
  const stream = input.cli === "cursor" || input.cli === "cursor-api" ? cursorChat({ ...input, mode: input.cli, prompt, system: CLI_BRIDGE_SYSTEM }) : input.cli === "codex" ? codexChat({ ...input, prompt, system: CLI_BRIDGE_SYSTEM, schema: CLI_RESPONSE_SCHEMA }) : claudeChat({
    modelId: input.modelId, messages: [], signal: input.signal, command: input.command, effort: input.effort,
    system: CLI_BRIDGE_SYSTEM, prompt, schema: CLI_RESPONSE_SCHEMA,
  })
  for await (const event of stream) {
    if (event.type === "text") { text += event.delta; continue }
    if (event.type === "output_limit") limited = true
    if (event.type === "thinking" || event.type === "spend" || event.type === "output_limit") yield event
  }
  input.signal?.throwIfAborted()
  if (limited) return
  const result = parseCliCompletion(text, input.tools)
  if (result.calls.length) {
    // Even structured models sometimes say "Done" before permission or execution.
    yield { type: "text", delta: `Requesting ${result.calls.map((call) => call.name).join(", ")}.` }
    yield { type: "calls", calls: result.calls }
    return
  }
  if (result.text) yield { type: "text", delta: result.text }
}
