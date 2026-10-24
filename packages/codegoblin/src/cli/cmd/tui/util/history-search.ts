import type { Message, Part } from "@codegoblin/sdk/v2"

export function searchHistory(messages: Message[], parts: Record<string, Part[]>, query: string) {
  const needle = query.trim().replace(/\s+/g, " ").toLowerCase()
  return messages
    .flatMap((message) => {
      const text = (parts[message.id] ?? [])
        .flatMap((part) => {
          if (part.type === "text" && !part.synthetic && !part.ignored) return [part.text]
          if (part.type === "file") return [part.filename ?? part.url]
          if (part.type === "tool" && part.state.status === "completed") return [part.state.output]
          if (part.type === "tool" && part.state.status === "error") return [part.state.error]
          return []
        })
        .join(" ")
        .replace(/\s+/g, " ")
        .trim()
      if (!text) return []
      const index = needle ? text.toLowerCase().indexOf(needle) : 0
      if (index < 0) return []
      const start = Math.max(0, index - 35)
      return [
        {
          messageID: message.id,
          role: message.role,
          time: message.time.created,
          preview: `${start ? "…" : ""}${text.slice(start, start + 160)}${text.length > start + 160 ? "…" : ""}`,
        },
      ]
    })
    .reverse()
}
