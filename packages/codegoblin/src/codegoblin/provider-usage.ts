/**
 * Subscription-account usage windows, surfaced by `GET /codegoblin/provider-usage`
 * for the status widget's usage strip. Two sources feed it:
 *
 * - **HTTP headers** (Codex/ChatGPT): the OAuth plugin fetch wrappers call
 *   `captureCodexUsageHeaders` opportunistically, into the in-memory store below.
 * - **CLI quota** (Claude Code): access runs through the CLI bridge, which has
 *   no HTTP response headers, so `provider/cli-agent.ts` asks the CLI itself
 *   (`claude --print /usage`) after a turn and persists the result. We read
 *   that file rather than duplicating the polling.
 *
 * `captureAnthropicUsageHeaders` is kept for whenever a direct Anthropic
 * request path exists again; it is unused while Claude goes through the CLI.
 *
 * CONSOLIDATION: a shared usage model is in flight (`@codegoblin/core/usage`
 * plus a richer `GET /codegoblin/usage` snapshot for the web/TUI usage
 * dialogs). This module is deliberately narrow — the flat, already-formatted
 * segments the status widget's one-line header needs. When that shared model
 * lands, this should become a projection of it rather than a second source:
 * keep `compactReset`/ordering (presentation) and drop the duplicate quota
 * read below in favour of the shared snapshot.
 */

import { readCliAgentUsage, type CliAgentQuota } from "@/provider/cli-agent"

export type ProviderUsageSegment = {
  /** Short window label, e.g. "5h", "7d", or the provider name. */
  label: string
  /** Percent of the window consumed, 0-100. */
  pct: number
  /** Human-ish reset hint, e.g. "4h1m". */
  reset?: string
  /** Which provider this window belongs to ("codex", "claude"). */
  provider: string
}

const store = new Map<string, { segments: ProviderUsageSegment[]; at: number }>()

/** Segments older than this are considered stale and dropped. */
const TTL_MS = 6 * 60 * 60 * 1000

export function recordProviderUsage(provider: string, segments: Omit<ProviderUsageSegment, "provider">[]) {
  if (!segments.length) return
  store.set(provider, {
    segments: segments.map((s) => ({ ...s, provider })),
    at: Date.now(),
  })
}

export function getProviderUsage(): ProviderUsageSegment[] {
  const now = Date.now()
  const out: ProviderUsageSegment[] = []
  for (const [key, value] of store) {
    if (now - value.at > TTL_MS) {
      store.delete(key)
      continue
    }
    out.push(...value.segments)
  }
  return out
}

/** Display names for the CLI-bridged providers; the raw ids are too long for
 * the widget's one-line header. */
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"]

/** Quota windows run from a few hours to a week; allow some slack past that. */
const PLAUSIBLE_WINDOW_MS = 10 * 24 * 60 * 60 * 1000

const CLI_PROVIDER_LABEL: Record<string, string> = {
  "claude-code": "claude",
  "cursor-agent": "cursor",
  "antigravity-cli": "antigravity",
}

/**
 * The CLI reports absolute reset times with a timezone suffix
 * ("Jul 24, 7:40pm (America/New_York)"), which is far too wide for the
 * widget's single-line header — three of those overflow the panel. Turn them
 * into the same compact countdown the header-based providers already use
 * ("4h20m"), falling back to just the clock time if the date won't parse.
 */
export function compactReset(value: string | undefined, now: Date = new Date()): string | undefined {
  if (!value) return undefined
  const trimmed = value.replace(/\s*\([^)]*\)\s*$/, "").trim()
  if (!trimmed) return undefined

  // Parse the components directly; Date.parse is too loose about formats like
  // "Jul 24, 7:40pm" and silently disagrees across runtimes.
  const match = /^([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i.exec(trimmed)
  if (match) {
    const month = MONTHS.indexOf(match[1].slice(0, 3).toLowerCase())
    const day = Number(match[2])
    const minute = Number(match[4] ?? 0)
    const meridiem = match[5].toLowerCase()
    let hour = Number(match[3]) % 12
    if (meridiem === "pm") hour += 12
    if (month >= 0) {
      const at = new Date(now.getFullYear(), month, day, hour, minute)
      // Only a date far in the past is a year boundary (seeing "Jan 2" in
      // December); a recently-passed one just means the quota file is stale.
      if (at.getTime() - now.getTime() < -PLAUSIBLE_WINDOW_MS) at.setFullYear(now.getFullYear() + 1)
      const delta = at.getTime() - now.getTime()
      // These windows are hours-to-a-week wide. Anything already elapsed, or
      // implausibly far out, means we are reading stale data — say nothing
      // rather than invent a countdown.
      if (delta > 0 && delta <= PLAUSIBLE_WINDOW_MS) {
        const mins = Math.round(delta / 60_000)
        if (mins < 60) return `${mins}m`
        const hours = Math.floor(mins / 60)
        if (hours < 24) return mins % 60 ? `${hours}h${mins % 60}m` : `${hours}h`
        const days = Math.floor(hours / 24)
        return hours % 24 ? `${days}d${hours % 24}h` : `${days}d`
      }
      return undefined
    }
  }
  // Unparseable (or already elapsed): keep just the clock time if there is one.
  return /\d{1,2}(:\d{2})?\s*(am|pm)/i.exec(trimmed)?.[0]?.replace(/\s+/g, "") ?? trimmed
}

/**
 * Every known usage window: header-captured providers plus whatever the CLI
 * bridge last recorded. Shortest windows first so a truncated strip still
 * shows the limit you are most likely to hit (the 5-hour one).
 *
 * `quotas` is injectable for tests; by default it reads what the CLI bridge
 * persisted after its last turn.
 */
export async function getAllProviderUsage(
  quotas?: CliAgentQuota[] | (() => Promise<CliAgentQuota[]>),
): Promise<ProviderUsageSegment[]> {
  const segments = getProviderUsage()
  const source = typeof quotas === "function" ? quotas : quotas ? async () => quotas : readCliAgentUsage
  const resolved = await Promise.resolve(source()).catch(() => [] as CliAgentQuota[])
  for (const quota of resolved) {
    for (const window of quota?.windows ?? []) {
      if (typeof window?.usedPercentage !== "number" || !Number.isFinite(window.usedPercentage)) continue
      const reset = compactReset(window.resetsAt)
      // A window whose reset time has already passed has rolled over, so the
      // recorded percentage no longer describes it — drop it instead of
      // reporting a number we know is wrong. It returns on the next CLI turn.
      if (window.resetsAt && !reset) continue
      segments.push({
        label: window.label,
        pct: Math.max(0, Math.min(100, window.usedPercentage)),
        ...(reset && { reset }),
        provider: CLI_PROVIDER_LABEL[quota.providerID] ?? quota.providerID,
      })
    }
  }
  const rank = (label: string) => (/^\d+\s*h/i.test(label) ? 0 : 1)
  return segments.sort((a, b) => rank(a.label) - rank(b.label))
}

function fmtReset(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return ""
  const mins = Math.round(seconds / 60)
  if (mins < 60) return `${mins}m`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h${mins % 60 ? `${mins % 60}m` : ""}`
  return `${Math.floor(hours / 24)}d${hours % 24 ? `${hours % 24}h` : ""}`
}

function windowLabel(minutes: number | undefined, fallback: string): string {
  if (!minutes || !Number.isFinite(minutes)) return fallback
  if (minutes < 60) return `${Math.round(minutes)}m`
  if (minutes < 24 * 60) return `${Math.round(minutes / 60)}h`
  return `${Math.round(minutes / (24 * 60))}d`
}

/**
 * Codex backend rate-limit headers, e.g.
 *   x-codex-primary-used-percent: 78
 *   x-codex-primary-window-minutes: 300
 *   x-codex-primary-reset-after-seconds: 4520
 * (secondary = the weekly window). Header names have drifted between Codex
 * releases, so match loosely on the used-percent suffix.
 */
export function captureCodexUsageHeaders(headers: Headers) {
  const segments: Omit<ProviderUsageSegment, "provider">[] = []
  for (const window of ["primary", "secondary"]) {
    let pct: number | undefined
    let windowMinutes: number | undefined
    let resetSeconds: number | undefined
    headers.forEach((value, key) => {
      const lower = key.toLowerCase()
      if (!lower.startsWith(`x-codex-${window}-`)) return
      const parsed = Number(value)
      if (!Number.isFinite(parsed)) return
      if (lower.endsWith("used-percent") || lower.endsWith("used_percent")) pct = parsed
      else if (lower.includes("window") && lower.includes("minutes")) windowMinutes = parsed
      else if (lower.includes("reset") && lower.includes("seconds")) resetSeconds = parsed
    })
    if (pct === undefined) continue
    segments.push({
      label: windowLabel(windowMinutes, window === "primary" ? "5h" : "1w"),
      pct: Math.max(0, Math.min(100, pct)),
      reset: resetSeconds !== undefined ? fmtReset(resetSeconds) : undefined,
    })
  }
  recordProviderUsage("codex", segments)
}

/**
 * Anthropic subscription (Claude Pro/Max) rate-limit headers, e.g.
 *   anthropic-ratelimit-unified-5h-utilization: 0.11
 *   anthropic-ratelimit-unified-7d-utilization: 0.02
 *   anthropic-ratelimit-unified-reset: 2026-07-20T12:00:00Z
 * Utilization may be reported as a 0-1 fraction or a 0-100 percent.
 */
export function captureAnthropicUsageHeaders(headers: Headers) {
  const segments: Omit<ProviderUsageSegment, "provider">[] = []
  let reset: string | undefined
  headers.forEach((value, key) => {
    const lower = key.toLowerCase()
    if (!lower.startsWith("anthropic-ratelimit-")) return
    if (lower.endsWith("-reset")) {
      const at = Date.parse(value)
      if (Number.isFinite(at)) reset = fmtReset((at - Date.now()) / 1000)
      return
    }
    const match = lower.match(/anthropic-ratelimit-(?:unified-)?(\d+[hdm])-utilization$/)
    if (!match) return
    const parsed = Number(value)
    if (!Number.isFinite(parsed)) return
    const pct = parsed <= 1 ? parsed * 100 : parsed
    segments.push({ label: match[1], pct: Math.max(0, Math.min(100, pct)) })
  })
  if (reset) {
    for (const segment of segments) {
      segment.reset ??= reset
    }
  }
  recordProviderUsage("claude", segments)
}
