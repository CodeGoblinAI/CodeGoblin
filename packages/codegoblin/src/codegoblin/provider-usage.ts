/**
 * Subscription-account usage windows (ChatGPT/Codex, …), captured
 * opportunistically from provider response headers by the OAuth plugin fetch
 * wrappers. Consumed by `GET /codegoblin/provider-usage` for the status
 * widget's usage strip; a richer provider-usage feature can replace this
 * store later without changing the wire shape.
 *
 * Only Codex feeds this today: Claude access now runs through the Claude Code
 * CLI bridge (`provider/cli-agent.ts`) rather than an OAuth fetch wrapper, so
 * there are no HTTP response headers to read. `captureAnthropicUsageHeaders`
 * is kept for whenever a direct Anthropic request path exists again; wiring
 * Claude usage today means asking the CLI, not parsing headers.
 */

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
