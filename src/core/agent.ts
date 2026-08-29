import type { Provider } from "./providers"
import { TOOL_SCHEMA, runTool } from "./tools"
import type { Permissions } from "./permission"
import { shouldCompact, planCompaction, applyCompaction, SUMMARY_PROMPT } from "./context"
import { parseTodos, type Todo } from "./todo"

export type Role = "user" | "assistant" | "system" | "tool"
export type ToolCall = { id: string; name: string; args: string }
export type Message = {
  role: Role
  /** What the model sees. For a user message with @-mentions this includes the attached files. */
  content: string
  /** What the human sees, when that differs - a message with its mentions still written as @paths. */
  display?: string
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[]
  tool_call_id?: string
}

export type AgentEvent =
  | { type: "text"; delta: string }
  | { type: "thinking"; delta: string }
  | { type: "tool_start"; name: string; args: string }
  | { type: "tool_end"; name: string; result: string }
  | { type: "tool_denied"; name: string }
  | { type: "compacted"; before: number; after: number }
  | { type: "plan"; todos: Todo[] }
  | { type: "turn_end" }

/**
 * Only the fields the API knows about.
 *
 * Messages carry a display copy for the UI, and providers that validate their
 * input reject unknown keys outright - so the wire gets the wire fields.
 */
const wire = (messages: Message[]) =>
  messages.map(({ role, content, tool_calls, tool_call_id }) => ({ role, content, tool_calls, tool_call_id }))

/**
 * The agent loop.
 *
 * Streams a completion; if the model asked for tools, runs them, appends the
 * results, and streams again. Repeats until it answers without calling a tool,
 * bounded by maxTurns so a model that keeps calling tools cannot spin forever.
 *
 * Tool calls arrive in fragments like text does - the name in one chunk, the
 * arguments across several - so they are accumulated by index before running.
 */
export async function* runAgent(input: {
  provider: Provider
  modelId: string
  apiKey: string
  messages: Message[]
  root: string
  contextWindow?: number
  permissions?: Permissions
  maxTurns?: number
  signal?: AbortSignal
}): AsyncGenerator<AgentEvent, void, unknown> {
  const maxTurns = input.maxTurns ?? 8

  // Compact before the first request rather than after a failure: the
  // provider rejects an oversized conversation outright.
  if (input.contextWindow && shouldCompact(input.messages, input.contextWindow)) {
    const before = input.messages.length
    const plan = planCompaction(input.messages, input.contextWindow)
    if (plan.summarise.length) {
      const summary = await summarise(input, plan.summarise)
      input.messages.splice(0, input.messages.length, ...applyCompaction(plan.system, summary, plan.keep))
      yield { type: "compacted", before, after: input.messages.length }
    }
  }

  for (let turn = 0; turn < maxTurns; turn++) {
    if (input.signal?.aborted) return

    const response = await fetch(input.provider.baseUrl, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${input.apiKey}` },
      body: JSON.stringify({
        model: input.modelId,
        messages: wire(input.messages),
        tools: TOOL_SCHEMA,
        stream: true,
      }),
      signal: input.signal,
    })

    if (!response.ok || !response.body) {
      const detail = await response.text().catch(() => "")
      throw new Error(`${input.provider.label} returned ${response.status}. ${detail.slice(0, 300)}`)
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ""
    let text = ""
    const calls = new Map<number, ToolCall>()

    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split("\n")
      buffer = lines.pop() ?? ""

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed.startsWith("data:")) continue
        const payload = trimmed.slice(5).trim()
        if (payload === "[DONE]") break
        let chunk: any
        try {
          chunk = JSON.parse(payload)
        } catch {
          continue
        }

        const delta = chunk?.choices?.[0]?.delta

        // Reasoning models stream their thinking on a separate field. The
        // name is not standardised, so accept the variants seen in the wild.
        const thought = delta?.reasoning_content ?? delta?.reasoning ?? delta?.thinking
        if (typeof thought === "string" && thought) {
          yield { type: "thinking", delta: thought }
        }

        if (typeof delta?.content === "string" && delta.content) {
          text += delta.content
          yield { type: "text", delta: delta.content }
        }

        for (const part of delta?.tool_calls ?? []) {
          const index = part.index ?? 0
          const existing = calls.get(index) ?? { id: "", name: "", args: "" }
          if (part.id) existing.id = part.id
          if (part.function?.name) existing.name = part.function.name
          if (part.function?.arguments) existing.args += part.function.arguments
          calls.set(index, existing)
        }
      }
    }

    if (calls.size === 0) {
      input.messages.push({ role: "assistant", content: text })
      yield { type: "turn_end" }
      return
    }

    const pending = [...calls.values()].filter((call) => call.name)
    input.messages.push({
      role: "assistant",
      content: text,
      tool_calls: pending.map((call) => ({
        id: call.id,
        type: "function" as const,
        function: { name: call.name, arguments: call.args || "{}" },
      })),
    })

    for (const call of pending) {
      if (input.signal?.aborted) return
      yield { type: "tool_start", name: call.name, args: call.args }
      let args: unknown = {}
      try {
        args = JSON.parse(call.args || "{}")
      } catch {
        // Leave args empty; the tool reports the failure itself.
      }

      // Consent happens here rather than inside the tool, so every surface
      // gets the same prompt and the model still receives a normal tool
      // result when it is refused.
      if (input.permissions && !(await input.permissions.check(call.name, call.args))) {
        const refusal = "refused by the user"
        input.messages.push({ role: "tool", tool_call_id: call.id, content: refusal })
        yield { type: "tool_denied", name: call.name }
        yield { type: "tool_end", name: call.name, result: refusal }
        continue
      }

      const result = await runTool(call.name, args, input.root)

      // The plan is state the surfaces render, not just a tool result.
      if (call.name === "todo_write") {
        yield { type: "plan", todos: parseTodos((args as Record<string, unknown>)?.todos) }
      }
      input.messages.push({ role: "tool", tool_call_id: call.id, content: result })
      yield { type: "tool_end", name: call.name, result }
    }
  }

  yield { type: "turn_end" }
}


/**
 * One non-streaming call to summarise the older half of a conversation.
 * Failure is not fatal: a crude fallback beats losing the turn.
 */
async function summarise(
  input: { provider: Provider; modelId: string; apiKey: string },
  messages: Message[],
): Promise<string> {
  try {
    const response = await fetch(input.provider.baseUrl, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${input.apiKey}` },
      body: JSON.stringify({
        model: input.modelId,
        messages: wire([...messages, { role: "user", content: SUMMARY_PROMPT }]),
        stream: false,
      }),
    })
    if (!response.ok) throw new Error(String(response.status))
    const body = (await response.json()) as any
    const text = body?.choices?.[0]?.message?.content
    if (typeof text === "string" && text.trim()) return text.trim()
    throw new Error("empty summary")
  } catch {
    return messages
      .filter((message) => message.role === "user")
      .map((message) => "- " + message.content.slice(0, 160))
      .join(String.fromCharCode(10))
  }
}
