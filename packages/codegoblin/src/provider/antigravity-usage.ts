import type { CliAgentQuota } from "./cli-agent"
import { lazy } from "@codegoblin/core/util/lazy"

/**
 * Resolve the pty binding through the `#pty` subpath import, exactly as
 * `Pty.Service` does: it maps to `bun-pty` under Bun and `node-pty` under Node.
 * Importing `pty.node` directly forces the Node binding into the Bun runtime,
 * which fails on Windows with "AttachConsole failed".
 */
const pty = lazy(() => import("#pty"))

/**
 * Antigravity quota.
 *
 * AGY has no `--usage` flag; the numbers only exist behind the interactive
 * `/usage` slash command, so this drives the CLI in a pty and scrapes the
 * panel it renders:
 *
 *   GEMINI MODELS
 *     Weekly Limit
 *       [██████░░░░] 60.92%
 *       61% remaining · Refreshes in 40h 21m
 *     Five Hour Limit
 *       [███░░░░░░░] 23.57%
 *       24% remaining · Refreshes in 2h 44m
 *
 * Careful: that percentage is what is **left**, not what has been consumed —
 * "60.92%" is paired with "61% remaining". Everything downstream stores
 * `usedPercentage`, so it is inverted here rather than at each call site.
 *
 * Launching AGY costs ~25s, so callers must treat this as an occasional
 * refresh (cached in the shared quota file), never a per-render lookup.
 */

const GROUP_RE = /^([A-Z][A-Z /]*MODELS)\s*$/
// AGY 1.1.11 renamed these headings from "Weekly Limit" to
// "Weekly Limit Remaining". Accept both forms so a CLI update cannot leave a
// previously cached quota to age out while fresh usage silently stops parsing.
const LIMIT_RE = /^(weekly|five hour|5 hour|daily|monthly)\s+limit(?:\s+remaining)?$/i
const REMAINING_RE = /(\d+(?:\.\d+)?)%\s*remaining/i
const PERCENT_RE = /(\d+(?:\.\d+)?)%/
const REFRESH_RE = /refreshes?\s+in\s+([0-9hmd ]+)/i

function windowLabel(value: string) {
  const lower = value.toLowerCase()
  if (lower.startsWith("weekly")) return "week"
  if (lower.startsWith("five hour") || lower.startsWith("5 hour")) return "5h"
  if (lower.startsWith("daily")) return "day"
  if (lower.startsWith("monthly")) return "month"
  return lower.replace(/\s+limit$/, "")
}

/** Strip ANSI/OSC so the pty transcript can be read as plain lines. */
export function stripAnsi(value: string) {
  return value
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)?/g, "")
    .replace(/\x1b[@-Z\\-_]/g, "")
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
}

export type AntigravityUsageWindow = {
  group: string
  label: string
  /** 0-100, already converted from AGY's "remaining" wording. */
  usedPercentage: number
  resetsAt?: string
}

/**
 * Parse the `/usage` panel. Only groups that report a real percentage are
 * returned — "Quota available" with no number is not a measurement.
 */
export function parseAntigravityUsage(raw: string): AntigravityUsageWindow[] {
  const lines = stripAnsi(raw)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)

  const out: AntigravityUsageWindow[] = []
  let group = ""
  let pending: string | undefined

  for (const line of lines) {
    const groupMatch = GROUP_RE.exec(line)
    if (groupMatch) {
      group = groupMatch[1].toLowerCase().replace(/\s+models$/, "").trim()
      pending = undefined
      continue
    }
    if (LIMIT_RE.test(line)) {
      pending = windowLabel(line)
      continue
    }
    if (!pending) continue

    const remaining = REMAINING_RE.exec(line)
    if (remaining) {
      const left = Number(remaining[1])
      if (Number.isFinite(left)) {
        const reset = REFRESH_RE.exec(line)?.[1]?.trim().replace(/\s+/g, "")
        out.push({
          group,
          label: pending,
          usedPercentage: Math.max(0, Math.min(100, 100 - left)),
          ...(reset && { resetsAt: reset }),
        })
      }
      pending = undefined
      continue
    }
    // The bar line carries the same figure; keep waiting for the wording that
    // states explicitly whether it is remaining, so the sense is never guessed.
    if (PERCENT_RE.test(line)) continue
  }
  return out
}

export function antigravityQuotaFrom(raw: string): CliAgentQuota | undefined {
  const windows = parseAntigravityUsage(raw)
  if (!windows.length) return undefined
  // AGY's own models are the Gemini group; the Claude/GPT group is a separate
  // allowance and would be misleading merged into one figure.
  const gemini = windows.filter((item) => item.group.includes("gemini"))
  const chosen = gemini.length ? gemini : windows
  return {
    providerID: "antigravity-cli",
    checkedAt: new Date().toISOString(),
    windows: chosen.map((item) => ({
      label: item.label,
      usedPercentage: item.usedPercentage,
      ...(item.resetsAt && { resetsAt: item.resetsAt }),
    })),
  }
}

/**
 * Drive `agy` in a pty, run `/usage`, and return the rendered panel. Resolves
 * undefined rather than throwing: quota is a nicety, and a CLI that changed its
 * prompt should never break a chat.
 */
export async function captureAntigravityUsage(input: {
  executable: string
  cwd: string
  timeoutMs?: number
}): Promise<string | undefined> {
  const timeout = input.timeoutMs ?? 90_000
  const { spawn } = await pty()
  return new Promise((resolve) => {
    let output = ""
    let settled = false
    let sentCommand = false
    let proc: ReturnType<typeof spawn> | undefined
    // Declared up front: `finish` can run from the spawn failure path below,
    // before the interval exists.
    let poll: ReturnType<typeof setInterval> | undefined
    let firstFigureAt: number | undefined
    let sentAt: number | undefined
    let retried = false

    const finish = (value: string | undefined) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (poll) clearInterval(poll)
      try {
        proc?.kill()
      } catch {}
      resolve(value)
    }

    const timer = setTimeout(() => finish(undefined), timeout)

    try {
      proc = spawn(input.executable, [], {
        name: "xterm-256color",
        cols: 140,
        rows: 45,
        cwd: input.cwd,
        env: process.env as Record<string, string>,
      })
    } catch {
      finish(undefined)
      return
    }

    proc.onData((chunk: string) => {
      output = `${output}${chunk}`.slice(-2_097_152)
    })
    proc.onExit(() => finish(undefined))

    const startedAt = Date.now()
    const sendUsage = () => {
      output = ""
      proc?.write("/usage")
      setTimeout(() => proc?.write("\r"), 600)
    }

    poll = setInterval(() => {
      const text = stripAnsi(output)
      const dense = text.replace(/\s+/g, "")

      if (!sentCommand) {
        // Type once the prompt is up, or the keystrokes are dropped. The banner
        // wording has moved between releases, so fall back on a plain delay
        // rather than waiting forever for a phrase.
        if (/shortcuts|Antigravity CLI/i.test(text) || Date.now() - startedAt > 6000) {
          sentCommand = true
          sentAt = Date.now()
          sendUsage()
        }
        return
      }

      // The panel prints one section per limit. Waiting for the footer alone
      // returned the weekly figure while the five-hour section was still
      // painting, so require every section this build reports before reading.
      const sections = (dense.match(/(weekly|fivehour|5hour|daily|monthly)limit/gi) ?? []).length
      const figures = (text.match(/remaining|Quota available/gi) ?? []).length
      if (figures > 0) firstFigureAt ??= Date.now()

      if (sections > 0 && figures >= sections) {
        finish(output)
        return
      }
      // Retry once: a keystroke lost to a slow first paint otherwise costs the
      // whole timeout.
      if (!retried && !figures && sentAt && Date.now() - sentAt > 12_000) {
        retried = true
        sentAt = Date.now()
        sendUsage()
        return
      }
      // Read what did arrive rather than returning nothing.
      if (firstFigureAt && Date.now() - firstFigureAt > 8000) finish(output)
    }, 400)
  })
}
