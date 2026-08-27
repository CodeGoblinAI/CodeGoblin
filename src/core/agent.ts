import type { Provider } from "./providers"
import { TOOL_SCHEMA, runTool } from "./tools"

export type Role = "user" | "assistant" | "system" | "tool"
export type ToolCall = { id: string; name: string; args: string }
export type Message = {
  role: Role
  content: string
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[]
  tool_call_id?: string
}

export type AgentEvent =
  | { type: "text"; delta: string }
  | { type: "thinking"; delta: string }
  | { type: "tool_start"; name: string; args: string }
  | { type: "tool_end"; name: string; result: string }
  | { type: "turn_end" }

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
  maxTurns?: number
  signal?: AbortSignal
}): AsyncGenerator<AgentEvent, void, unknown> {
  const maxTurns = input.maxTurns ?? 8

  for (let turn = 0; turn < maxTurns; turn++) {
    const response = await fetch(input.provider.baseUrl, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${input.apiKey}` },
      body: JSON.stringify({
        model: input.modelId,
        messages: input.messages,
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
      yield { type: "tool_start", name: call.name, args: call.args }
      let args: unknown = {}
      try {
        args = JSON.parse(call.args || "{}")
      } catch {
        // Leave args empty; the tool reports the failure itself.
      }
      const result = await runTool(call.name, args, input.root)
      input.messages.push({ role: "tool", tool_call_id: call.id, content: result })
      yield { type: "tool_end", name: call.name, result }
    }
  }

  yield { type: "turn_end" }
}
