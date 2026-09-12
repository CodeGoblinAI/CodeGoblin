import { authHeaders, type Provider } from "./providers"
import { TOOL_SCHEMA, runTool, isConcurrent } from "./tools"
import type { Permissions } from "./permission"
import { shouldCompact, planCompaction, applyCompaction, SUMMARY_PROMPT } from "./context"
import { parseTodos, type Todo } from "./todo"
import type { History } from "./undo"

export type Role = "user" | "assistant" | "system" | "tool"
export type ToolCall = { id: string; name: string; args: string }

/**
 * A picture attached to a message.
 *
 * Held as a data URL because that is what the wire wants and what a session
 * file can hold: a path would go stale the moment the file moved, and a
 * conversation reopened next week should still show what it was asked about.
 */
export type Attachment = { name: string; dataUrl: string }

export type Message = {
  role: Role
  /** What the model sees. For a user message with @-mentions this includes the attached files. */
  content: string
  /** What the human sees, when that differs - a message with its mentions still written as @paths. */
  display?: string
  /** Images attached to this message, for models that can be shown one. */
  images?: Attachment[]
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[]
  tool_call_id?: string
}

export type AgentEvent =
  | { type: "text"; delta: string }
  | { type: "thinking"; delta: string }
  /**
   * `id` is the model's own tool-call id, carried through so a surface can
   * match a result to the row that asked for it. Without it a surface has to
   * assume the end of one tool follows the start of it, which only held while
   * tools ran strictly one after another.
   */
  | { type: "tool_start"; id: string; name: string; args: string }
  | { type: "tool_end"; id: string; name: string; result: string }
  | { type: "tool_denied"; id: string; name: string }
  | { type: "compacted"; before: number; after: number }
  | { type: "plan"; todos: Todo[] }
  | { type: "spend"; input: number; output: number }
  /**
   * The loop ran out of turns with the model still calling tools.
   *
   * Without this the surfaces could not tell a finished answer from an
   * abandoned one: the loop fell out of its bounds and emitted the same
   * turn_end a normal reply ends with, so work that stopped half-done looked
   * exactly like work that was complete.
   */
  | { type: "limit"; turns: number }
  | { type: "turn_end" }

/**
 * The chat endpoint, or a refusal.
 *
 * Image, audio and 3D providers sit in the same catalogue but have nowhere
 * to send a conversation. The surfaces route those prompts to their own
 * generators before it gets this far; this is the backstop, and it says what
 * happened rather than posting to undefined.
 */
function chatEndpoint(provider: Provider): string {
  if (!provider.baseUrl) {
    throw new Error(
      `${provider.label} generates media, not conversation - pick a text model with /model to chat`,
    )
  }
  return provider.baseUrl
}

/**
 * Only the fields the API knows about.
 *
 * Messages carry a display copy for the UI, and providers that validate their
 * input reject unknown keys outright - so the wire gets the wire fields.
 */
const wire = (messages: Message[], memory?: string, images = false) => {
  const sent = messages.map(({ role, content, images: attached, tool_calls, tool_call_id }) => {
    // A message with pictures becomes the multimodal shape, which is the only
    // form a vision model reads them in. Without this the attachment simply
    // did not reach the model: content was always a plain string.
    if (images && attached?.length) {
      return {
        role,
        content: [
          ...(content ? [{ type: "text", text: content }] : []),
          ...attached.map((image) => ({ type: "image_url", image_url: { url: image.dataUrl } })),
        ],
        tool_calls,
        tool_call_id,
      }
    }

    // Attached to a model that cannot see - say so rather than leave the model
    // answering a question about a picture it was never sent.
    if (!images && attached?.length) {
      const names = attached.map((image) => image.name).join(", ")
      return {
        role,
        content:
          content +
          String.fromCharCode(10, 10) +
          `(${attached.length === 1 ? "an image was" : "images were"} attached - ${names} - ` +
          `but this model cannot see images, so it has not been sent)`,
        tool_calls,
        tool_call_id,
      }
    }

    return { role, content, tool_calls, tool_call_id }
  })

  // Memory rides along with the system prompt rather than being stored in
  // the conversation: it is read fresh every turn, so forgetting something
  // takes effect immediately instead of lingering in old messages.
  const first = sent[0]
  if (memory && first?.role === "system" && typeof first.content === "string") {
    sent[0] = { ...first, content: first.content + String.fromCharCode(10, 10) + memory }
  }
  return sent
}

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
  /** Whether this model can be shown a picture; see acceptsImages in providers. */
  images?: boolean
  permissions?: Permissions
  /** What is remembered, folded into the system prompt for this request. */
  memory?: string
  /** Given a turn, keeps the previous state of every file the turn writes. */
  history?: History
  /**
   * How hard the model should think, for models that take it.
   *
   * The caller decides whether this model understands the field - a provider
   * handed a reasoning_effort it does not know can reject the whole request,
   * so the loop only forwards what it is given.
   */
  effort?: "low" | "medium" | "high"
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

    const response = await fetch(chatEndpoint(input.provider), {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders(input.provider, input.apiKey) },
      body: JSON.stringify({
        model: input.modelId,
        messages: wire(input.messages, input.memory, input.images),
        tools: TOOL_SCHEMA,
        stream: true,
        ...(input.effort ? { reasoning_effort: input.effort } : {}),
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

        // Usage rides on the final chunk of the stream, after the deltas
        // stop. Throwing it away is why nothing could say what a session had
        // cost - the one number people want from a tool that spends their
        // money.
        const used = chunk?.usage
        if (used && (used.prompt_tokens || used.completion_tokens)) {
          yield {
            type: "spend",
            input: Number(used.prompt_tokens ?? 0),
            output: Number(used.completion_tokens ?? 0),
          }
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

    // Consent runs first, in the order asked, one at a time. A permission
    // prompt is a question put to a person; two of them arriving at once is
    // not something a person can answer. Only the work afterwards overlaps.
    const decided: { call: ToolCall; args: unknown; allowed: boolean }[] = []
    for (const call of pending) {
      if (input.signal?.aborted) return
      let args: unknown = {}
      try {
        args = JSON.parse(call.args || "{}")
      } catch {
        // Leave args empty; the tool reports the failure itself.
      }
      // Consent happens here rather than inside the tool, so every surface
      // gets the same prompt and the model still receives a normal tool
      // result when it is refused.
      const allowed = !input.permissions || (await input.permissions.check(call.name, call.args))
      decided.push({ call, args, allowed })
    }

    // Every chip opens at once, so a turn that asked for four reads looks like
    // four reads rather than one that keeps changing its name.
    for (const { call } of decided) {
      yield { type: "tool_start", id: call.id, name: call.name, args: call.args }
    }

    const run = (entry: { call: ToolCall; args: unknown }) =>
      runTool(entry.call.name, entry.args, input.root, async (relative) => {
        await input.history?.record(input.root, relative)
      })

    // Reads overlap; everything else keeps its order. Four file reads used to
    // cost four round trips end to end for no reason - they do not touch each
    // other, and nothing about them depends on which finishes first.
    const results = new Map<string, string>()
    const runnable = decided.filter((entry) => entry.allowed)
    await Promise.all(
      runnable
        .filter((entry) => isConcurrent(entry.call.name))
        .map(async (entry) => {
          results.set(entry.call.id, await run(entry))
        }),
    )
    for (const entry of runnable.filter((each) => !isConcurrent(each.call.name))) {
      if (input.signal?.aborted) return
      results.set(entry.call.id, await run(entry))
    }

    // Reported in the order the model asked for them, whatever order they
    // finished in, so a transcript reads the same way twice.
    for (const { call, args, allowed } of decided) {
      if (!allowed) {
        const refusal =
          input.permissions?.mode === "plan"
            ? "not run: plan mode is on, so nothing that changes files or runs commands is executed"
            : "refused by the user"
        input.messages.push({ role: "tool", tool_call_id: call.id, content: refusal })
        yield { type: "tool_denied", id: call.id, name: call.name }
        yield { type: "tool_end", id: call.id, name: call.name, result: refusal }
        continue
      }

      const result = results.get(call.id) ?? "not run"
      // The plan is state the surfaces render, not just a tool result.
      if (call.name === "todo_write") {
        yield { type: "plan", todos: parseTodos((args as Record<string, unknown>)?.todos) }
      }
      input.messages.push({ role: "tool", tool_call_id: call.id, content: result })
      yield { type: "tool_end", id: call.id, name: call.name, result }
    }
  }

  // Falling out of the loop means the last turn still asked for tools. Every
  // other way out returns, so this is the only path that reaches here.
  yield { type: "limit", turns: maxTurns }
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
    const response = await fetch(chatEndpoint(input.provider), {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders(input.provider, input.apiKey) },
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
