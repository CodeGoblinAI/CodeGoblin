import { MessageV2 } from "./message-v2"

export function loadedToolNames(messages: MessageV2.WithParts[], searchTool = "mcp_tool_search") {
  return new Set(
    messages.flatMap((message) =>
      message.parts.flatMap((part) => {
        if (part.type !== "tool") return []
        if (part.tool !== searchTool) return []
        if (part.state.status !== "completed" || !Array.isArray(part.state.metadata.tools)) return []
        return part.state.metadata.tools.filter((name): name is string => typeof name === "string")
      }),
    ),
  )
}

export function rankTools(
  query: string,
  entries: Array<{ name: string; description: string }>,
  requested: string[] = [],
  limit = 5,
) {
  const exact = new Set(requested.filter((name) => entries.some((entry) => entry.name === name)))
  const words = tokenize(query)
  const ranked = entries
    .map((entry) => ({
      ...entry,
      score:
        (exact.has(entry.name) ? 10_000 : 0) +
        [...tokenize(`${entry.name} ${entry.description}`)].reduce(
          (score, word) => score + (words.has(word) ? 1 : 0),
          0,
        ),
    }))
    .filter((entry) => entry.score > 0)
    .toSorted((a, b) => b.score - a.score || a.name.localeCompare(b.name))
  const best = ranked[0]?.score
  return ranked.filter((entry) => entry.score === best).slice(0, limit)
}

function tokenize(value: string) {
  return new Set(
    value
      .toLowerCase()
      .split(/[^a-z0-9_]+/)
      .filter((word) => word.length > 1),
  )
}
