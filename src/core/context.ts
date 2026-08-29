import type { Message } from "./agent"

/**
 * Keeping a conversation inside the model's context window.
 *
 * Messages accumulate: a tool that reads a large file can add thousands of
 * tokens in one turn. Without this a long session eventually fails with a
 * provider error, which is a bad way to learn about a limit.
 *
 * Token counts here are estimates. Real tokenisation differs per model and is
 * not worth a dependency for a threshold decision - but the estimate is
 * deliberately conservative, so compaction happens slightly early rather than
 * slightly late.
 */

/** Roughly four characters per token for English and code. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

export function messageTokens(message: Message): number {
  let total = estimateTokens(message.content ?? "")
  for (const call of message.tool_calls ?? []) {
    total += estimateTokens(call.function.name + call.function.arguments)
  }
  // Per-message overhead for role and framing.
  return total + 4
}

export function conversationTokens(messages: Message[]): number {
  return messages.reduce((sum, message) => sum + messageTokens(message), 0)
}

export type Usage = { used: number; limit: number; percent: number }

export function usage(messages: Message[], contextWindow: number): Usage {
  const used = conversationTokens(messages)
  // A generation model has no window to fill. Dividing by zero read as 100%,
  // which said the conversation was full when there was no conversation.
  const percent = contextWindow > 0 ? Math.min(100, Math.round((used / contextWindow) * 100)) : 0
  return { used, limit: contextWindow, percent }
}

/** What a turn used, as the provider reported it. */
export type Spend = { input: number; output: number; dollars?: number }

/**
 * Add up a turn.
 *
 * Providers report usage on the last chunk of the stream and we were
 * throwing it away, so the app could not say what a session had cost -
 * which is the one number people actually want from a tool that spends
 * money on their behalf.
 */
export function addSpend(total: Spend, next: Spend): Spend {
  return {
    input: total.input + next.input,
    output: total.output + next.output,
    dollars:
      total.dollars === undefined && next.dollars === undefined
        ? undefined
        : (total.dollars ?? 0) + (next.dollars ?? 0),
  }
}

export function priceOf(
  usage: { input: number; output: number },
  price?: { input: number; output: number },
): number | undefined {
  if (!price) return undefined
  return (usage.input * price.input + usage.output * price.output) / 1_000_000
}

/** Cents to four places while it is pennies, then two. Never bare zero. */
export function formatSpend(spend: Spend): string {
  if (spend.dollars === undefined) return `${(spend.input + spend.output).toLocaleString()} tok`
  if (spend.dollars === 0) return "$0"
  // Built from a char code: a dollar sign next to a template placeholder has
  // been eaten by tooling here more than once, and it fails silently.
  const DOLLAR = String.fromCharCode(36)
  return DOLLAR + (spend.dollars < 0.01 ? spend.dollars.toFixed(4) : spend.dollars.toFixed(2))
}

/** Compact once the conversation passes this share of the window. */
export const COMPACT_AT = 0.75

/** Keep roughly this share of the window as verbatim recent history. */
const PRESERVE_RECENT = 0.25

export function shouldCompact(messages: Message[], contextWindow: number): boolean {
  return conversationTokens(messages) > contextWindow * COMPACT_AT
}

/**
 * Split a conversation into the part to summarise and the part to keep.
 *
 * The system prompt always survives, and the split never lands between an
 * assistant message carrying tool_calls and the tool results answering them -
 * providers reject a tool result whose call is missing.
 */
export function planCompaction(messages: Message[], contextWindow: number) {
  const system = messages.filter((message) => message.role === "system")
  const rest = messages.filter((message) => message.role !== "system")

  const budget = contextWindow * PRESERVE_RECENT
  let kept = 0
  let index = rest.length

  while (index > 0) {
    const next = messageTokens(rest[index - 1]!)
    if (kept + next > budget && rest.length - index >= 2) break
    kept += next
    index--
  }

  // Walk forward off any orphaned tool results.
  while (index < rest.length && rest[index]!.role === "tool") index++

  return { system, summarise: rest.slice(0, index), keep: rest.slice(index) }
}

export const SUMMARY_PROMPT =
  "Summarise the conversation so far for your own future reference. Keep decisions made, " +
  "files touched, what worked and what did not, and anything still outstanding. " +
  "Be specific about names and paths. Do not mention that this is a summary."

/** Builds the replacement history once a summary has been generated. */
export function applyCompaction(
  system: Message[],
  summary: string,
  keep: Message[],
): Message[] {
  return [
    ...system,
    { role: "user", content: "Summary of earlier conversation:" + String.fromCharCode(10) + summary },
    ...keep,
  ]
}
