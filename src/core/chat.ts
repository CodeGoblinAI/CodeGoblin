import { providerError } from "./provider-error"
import { authHeaders, type Provider } from "./providers"
import { verifyLocalModel } from "./local-provider"
import { localRuntime } from "./local-runtime"
import { claudeChat } from "./claude-cli"
import { cliCompletion } from "./cli-completion"
import { within } from "./stall"

export type Role = "user" | "assistant" | "system"
export type Message = { role: Role; content: string }

/**
 * Streaming chat client, written from scratch on fetch.
 *
 * The OpenAI chat-completions stream is server-sent events: lines prefixed
 * `data: `, each a JSON chunk, terminated by `data: [DONE]`. Chunks can be
 * split across network reads, so the tail of a read is buffered until the
 * next newline rather than parsed eagerly.
 */
export async function* streamChat(input: {
  provider: Provider
  modelId: string
  apiKey: string
  messages: Message[]
  signal?: AbortSignal
}): AsyncGenerator<string, void, unknown> {
  if (input.provider.cli === "claude-code") {
    for await (const event of claudeChat(input)) if (event.type === "text") yield event.delta
    return
  }
  if (input.provider.cli) {
    for await (const event of cliCompletion({ ...input, cli: input.provider.cli, tools: [] })) if (event.type === "text") yield event.delta
    return
  }
  if (input.provider.runtime) {
    const lease = await localRuntime.acquire(input.modelId, { signal: input.signal })
    try {
      yield* streamChat({ ...input, provider: { ...input.provider, runtime: false, baseUrl: lease.baseUrl + "/chat/completions", auth: () => ({ authorization: "Bearer " + lease.key }) } })
    } finally { lease.release() }
    return
  }
  if (!input.provider.baseUrl) {
    throw new Error(`${input.provider.label} generates media, not conversation - pick a text model with /model`)
  }
  await verifyLocalModel(input.provider, input.modelId, input.signal)
  // A provider that goes silent is given up on (see stall.ts), as in the agent loop.
  const silent = new AbortController()
  const signal = input.signal ? AbortSignal.any([input.signal, silent.signal]) : silent.signal
  const response = await within(fetch(input.provider.baseUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...authHeaders(input.provider, input.apiKey),
    },
    body: JSON.stringify({
      model: input.modelId,
      ...(input.provider.localThinking !== undefined ? { chat_template_kwargs: { enable_thinking: input.provider.localThinking } } : {}),
      messages: input.messages,
      stream: true,
    }),
    signal,
  }), () => silent.abort(), input.provider.label, { endless: Boolean(input.provider.local) })

  if (!response.ok || !response.body) {
    const detail = await response.text().catch(() => "")
    throw new Error(providerError(input.provider, response.status, detail))
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""

  while (true) {
    const { done, value } = await within(reader.read(), () => { void reader.cancel().catch(() => {}) }, input.provider.label, { endless: Boolean(input.provider.local) })
    if (done) break
    buffer += decoder.decode(value, { stream: true })

    // Keep the trailing partial line for the next read.
    const lines = buffer.split("\n")
    buffer = lines.pop() ?? ""

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed.startsWith("data:")) continue
      const payload = trimmed.slice(5).trim()
      if (payload === "[DONE]") return
      try {
        const chunk = JSON.parse(payload)
        const delta = chunk?.choices?.[0]?.delta?.content
        if (typeof delta === "string" && delta) yield delta
      } catch {
        // A malformed chunk should not kill the stream.
      }
    }
  }
}
