import type { Message } from "./agent"
import type { Model, Provider } from "./providers"
import { conversationTokens, planCompaction } from "./context"

/**
 * Compacting a conversation that has been left alone, before its cache goes.
 *
 * A provider's prompt cache makes a long conversation cheap to continue: the
 * history is read back at a tenth of the price or less. Leave it idle past
 * the cache's lifetime and the next message pays for all of it again in full.
 * Summarising it just before then - while reading it is still cheap - means
 * the next message sends a summary instead.
 *
 * Whether that is worth doing is arithmetic, different for every model, so
 * nothing here names one:
 *
 *   - It needs a cache that lasts long enough to wait on. A five-minute cache
 *     would have this compacting whenever someone stopped to read an answer.
 *   - It needs the model's full and cached prices, to know what is saved.
 *   - It has to save real money. A summary costs a request and loses the
 *     word-for-word history (kept in the archive, but not in front of the
 *     model), so it is only done when it saves at least `min` dollars on the
 *     next message. On a cheap model with a 128k window that never happens;
 *     on an expensive one with a long conversation it does.
 */

/** A cache shorter than this is not waited on. */
export const MIN_CACHE_MINUTES = 20

/** Fire this far through the cache's life, so the summary request itself still reads from it. */
const FIRE_AT = 0.8

/** Recent history kept word for word by an idle compaction, in tokens. A quarter of this window. */
const IDLE_KEEP_WINDOW = 120_000

/** What the summary itself is assumed to come to, in tokens, for the estimate. */
const SUMMARY_TOKENS = 1500

export type IdleCompaction = {
  /** How long after the last activity to do it, in milliseconds. */
  afterMs: number
  /** Estimated dollars saved on the next message, net of the summary request. */
  saving: number
  /** The window to plan the compaction against, so only the recent part is kept. */
  keepWindow: number
}

export function idleKeepWindow(contextWindow: number): number {
  return Math.min(contextWindow, IDLE_KEEP_WINDOW)
}

/**
 * Whether this conversation should be compacted if it is left idle, and when.
 * Undefined when it should not: off, a subscription model, no known cache
 * lifetime or price (a local model has neither), nothing old enough to
 * summarise, or too little saved.
 *
 * CODEGOBLIN_IDLE_AFTER_MS replaces the wait, for watching it happen in a
 * test without sitting through most of a cache's life.
 */
export function idleCompaction(input: { messages: Message[]; provider: Provider; model: Model; min: number }, env: Record<string, string | undefined> = process.env): IdleCompaction | undefined {
  const { provider, model, min } = input
  const price = model.price
  if (!(min > 0) || provider.cli) return undefined
  if (!provider.cacheMinutes || provider.cacheMinutes < MIN_CACHE_MINUTES) return undefined
  if (!price || price.cacheRead === undefined || !(price.input > price.cacheRead) || model.contextWindow <= 0) return undefined
  const keepWindow = idleKeepWindow(model.contextWindow)
  const plan = planCompaction(input.messages, keepWindow)
  if (!plan.summarise.length) return undefined
  const all = conversationTokens(input.messages)
  const kept = conversationTokens(plan.system) + conversationTokens(plan.keep)
  const perToken = 1 / 1_000_000
  // Left alone: the whole conversation is sent again at full price.
  const without = all * price.input * perToken
  // Compacted now: the summary request reads it from the cache and writes a summary; later the kept part and the summary go at full price.
  const withIt = (all * price.cacheRead + SUMMARY_TOKENS * price.output + (kept + SUMMARY_TOKENS) * price.input) * perToken
  const saving = without - withIt
  if (saving < min) return undefined
  const override = Number(env.CODEGOBLIN_IDLE_AFTER_MS ?? "")
  return { afterMs: override > 0 ? override : Math.round(provider.cacheMinutes * FIRE_AT * 60_000), saving, keepWindow }
}

/** "about $0.20" for the note left in the conversation. */
export function idleNote(saving: number): string {
  const DOLLAR = String.fromCharCode(36)
  return "compacted while idle, before the provider's cache expired - saves about " + DOLLAR + saving.toFixed(2) + " on your next message. The full history is still in /export."
}
