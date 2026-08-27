import type { Provider } from "./providers"

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
  apiKey: string
  messages: Message[]
  signal?: AbortSignal
}): AsyncGenerator<string, void, unknown> {
  const response = await fetch(input.provider.baseUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${input.apiKey}`,
    },
    body: JSON.stringify({
      model: input.provider.model,
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
