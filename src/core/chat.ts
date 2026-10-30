import { authHeaders, type Provider } from "./providers"
import { verifyLocalModel } from "./local-provider"
import { localRuntime } from "./local-runtime"
import { claudeChat } from "./claude-cli"
import { cliCompletion } from "./cli-completion"

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
  const response = await fetch(input.provider.baseUrl, {
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
    signal: input.signal,
  })

  if (!response.ok || !response.body) {
    const detail = await response.text().catch(() => "")
    throw new Error(`${input.provider.label} returned ${response.status}. ${detail.slice(0, 300)}`)
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""

  while (true) {
    const { done, value } = await reader.read()
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
