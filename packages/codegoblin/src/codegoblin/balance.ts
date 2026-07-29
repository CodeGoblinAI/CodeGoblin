import fs from "fs/promises"
import os from "os"
import path from "path"
import {
  cliAgentQuotaStatuses,
  readCliAgentUsage,
  refreshCliAgentUsage,
  type CliAgentQuota,
} from "@/provider/cli-agent"
import { compactReset } from "@/codegoblin/provider-usage"

export type CodeGoblinBalanceProvider = "hoard" | "deepseek" | "moonshot"

export type CodeGoblinBalanceEntry = {
  provider: CodeGoblinBalanceProvider
  label: string
  amount: number
  unit: string
  source: string
  live: boolean
  checkedAt?: string
}

export type CodeGoblinBalanceError = {
  provider: Exclude<CodeGoblinBalanceProvider, "hoard">
  message: string
}

type Env = Record<string, string | undefined>
type FetchLike = (input: string, init?: RequestInit) => Promise<Response>
let liveCache:
  | {
      expiresAt: number
      value: Awaited<ReturnType<typeof liveBalances>>
    }
  | undefined

const PROVIDERS = ["deepseek", "moonshot"] as const
const MANUAL_BALANCE_ENV = {
  hoard: ["CODEGOBLIN_TOKEN_HOARD_USD"],
  deepseek: ["CODEGOBLIN_DEEPSEEK_BALANCE_USD", "CODEGOBLIN_DEEPSEEK_CREDITS_USD", "DEEPSEEK_BALANCE_USD"],
  moonshot: [
    "CODEGOBLIN_MOONSHOT_BALANCE_USD",
    "CODEGOBLIN_MOONSHOT_CREDITS_USD",
    "MOONSHOT_BALANCE_USD",
    "KIMI_BALANCE_USD",
  ],
} satisfies Record<CodeGoblinBalanceProvider, readonly string[]>

const API_KEY_ENV = {
  deepseek: ["DEEPSEEK_API_KEY", "CODEGOBLIN_DEEPSEEK_API_KEY"],
  moonshot: ["MOONSHOT_API_KEY", "KIMI_API_KEY", "CODEGOBLIN_MOONSHOT_API_KEY"],
} satisfies Record<Exclude<CodeGoblinBalanceProvider, "hoard">, readonly string[]>

export const CodeGoblinBalance = {
  async resolve(input: {
    cwd: string
    env?: Env
    fetch?: FetchLike
    now?: Date
    includeLocalEnv?: boolean
    /** `"force"` ignores the per-provider TTLs; plain `true` respects them. */
    refreshQuotas?: boolean | "force"
    timeoutMs?: number
    /** Reuse provider API balances briefly while usage dialogs poll local quota state. */
    cacheLive?: boolean
  }) {
    const env = {
      ...process.env,
      ...(input.includeLocalEnv === false ? {} : await loadLocalEnv(input.cwd)),
      ...(input.env ?? {}),
    }
    const configured = configuredBalances(env)
    const live =
      input.cacheLive && liveCache && liveCache.expiresAt > Date.now()
        ? liveCache.value
        : await liveBalances({
            env,
            fetch: input.fetch ?? fetch,
            now: input.now ?? new Date(),
            timeoutMs: input.timeoutMs ?? 5_000,
          }).then((value) => {
            if (input.cacheLive) liveCache = { expiresAt: Date.now() + 30_000, value }
            return value
          })
    const quotas = liveQuotas(
      input.refreshQuotas ? await refreshCliAgentUsage(input.refreshQuotas === "force") : await readCliAgentUsage(),
      input.now ?? new Date(),
    )
    const byProvider = new Map<CodeGoblinBalanceProvider, CodeGoblinBalanceEntry>()
    for (const entry of configured) byProvider.set(entry.provider, entry)
    for (const entry of live.balances) byProvider.set(entry.provider, entry)
    return {
      balances: [...byProvider.values()],
      quotas,
      quotaStatuses: cliAgentQuotaStatuses(quotas),
      errors: live.errors,
    }
  },
  configured: configuredBalances,
  formatFooter,
  liveQuotas,
  selectedBalanceProvider,
  parseDeepSeekBalance,
  parseMoonshotBalance,
}

/** Ordering key in minutes, so the window you are likeliest to hit shows first. */
const WINDOW_MINUTES: Record<string, number> = { session: 300, hour: 60, day: 1440, week: 10080, month: 43200 }

function windowRank(label: string) {
  const key = label.trim().toLowerCase()
  const known = WINDOW_MINUTES[key]
  if (known) return known
  const match = /^(\d+)\s*([mhdw])/.exec(key)
  if (!match) return Number.MAX_SAFE_INTEGER
  return Number(match[1]) * { m: 1, h: 60, d: 1440, w: 10080 }[match[2] as "m" | "h" | "d" | "w"]
}

const COUNTDOWN = /^(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?$/

function formatDuration(ms: number) {
  const mins = Math.round(ms / 60_000)
  if (mins < 60) return `${mins}m`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return mins % 60 ? `${hours}h${mins % 60}m` : `${hours}h`
  const days = Math.floor(hours / 24)
  return hours % 24 ? `${days}d${hours % 24}h` : `${days}d`
}

/**
 * What a recorded reset time means *now*.
 *
 * Providers report resets two different ways and both go stale on disk. An
 * absolute time ("Jul 28, 4:50am (America/New_York)") is re-expressed as a
 * countdown against the clock; a countdown ("3h53m") was true when it was
 * captured, so the time since then is subtracted. Either way, `undefined` means
 * the window has already rolled over — the percentage stored alongside it no
 * longer describes anything real.
 */
export function quotaReset(resetsAt: string, elapsedMs: number, now: Date): string | undefined {
  const raw = resetsAt.trim()
  const match = COUNTDOWN.exec(raw)
  if (match && match.slice(1).some(Boolean)) {
    const total = ((Number(match[1] ?? 0) * 24 + Number(match[2] ?? 0)) * 60 + Number(match[3] ?? 0)) * 60_000
    const left = total - elapsedMs
    return left > 0 ? formatDuration(left) : undefined
  }
  return compactReset(raw, now)
}

/**
 * Quota windows that still describe the present, newest-expiring first.
 *
 * A stored percentage is only meaningful until its window resets, and quota is
 * only re-read for whichever CLI you last ran — so a provider you have not used
 * today keeps serving yesterday's numbers. Dropping elapsed windows here, in
 * the one place both the footer and the usage panel read from, means neither
 * can show a figure we already know is wrong, and the two can never disagree.
 */
export function liveQuotas(quotas: readonly CliAgentQuota[], now: Date = new Date()): CliAgentQuota[] {
  return quotas.flatMap((quota) => {
    const checkedAt = quota.checkedAt ? Date.parse(quota.checkedAt) : Number.NaN
    const elapsed = Number.isFinite(checkedAt) ? Math.max(0, now.getTime() - checkedAt) : 0
    const windows = quota.windows.flatMap((window) => {
      if (!window.resetsAt) return [window]
      const reset = quotaReset(window.resetsAt, elapsed, now)
      if (!reset) return []
      return [{ ...window, resetsAt: reset }]
    })
    if (!windows.length) return []
    return [{ ...quota, windows: [...windows].sort((a, b) => windowRank(a.label) - windowRank(b.label)) }]
  })
}

function configuredBalances(env: Env): CodeGoblinBalanceEntry[] {
  return (["hoard", ...PROVIDERS] as const).flatMap((provider) => {
    const match = firstValue(env, MANUAL_BALANCE_ENV[provider])
    const amount = parseAmount(match?.value)
    if (amount === undefined || !match) return []
    return [
      {
        provider,
        label: provider === "moonshot" ? "moon" : provider,
        amount,
        unit: "USD",
        source: match.name,
        live: false,
      } satisfies CodeGoblinBalanceEntry,
    ]
  })
}

async function liveBalances(input: { env: Env; fetch: FetchLike; now: Date; timeoutMs: number }) {
  const results = await Promise.all(PROVIDERS.map((provider) => liveBalance(provider, input)))
  return {
    balances: results.flatMap((result) => (result.ok && result.balance ? [result.balance] : [])),
    errors: results.flatMap((result) => (result.ok ? [] : [result.error])),
  }
}

async function liveBalance(
  provider: Exclude<CodeGoblinBalanceProvider, "hoard">,
  input: { env: Env; fetch: FetchLike; now: Date; timeoutMs: number },
) {
  const key = firstValue(input.env, API_KEY_ENV[provider])
  if (!key) return { ok: true as const, balance: undefined }

  const endpoint =
    provider === "deepseek" ? "https://api.deepseek.com/user/balance" : "https://api.moonshot.cn/v1/users/me/balance"
  const result = await fetchBalance({ ...input, endpoint, key: key.value })

  if ("error" in result) {
    return {
      ok: false as const,
      error: { provider, message: "Balance API is unavailable; using any manual fallback." },
    }
  }
  const response = result.response
  if (!response.ok) {
    return {
      ok: false as const,
      error: { provider, message: `Balance API returned HTTP ${response.status}; using any manual fallback.` },
    }
  }

  const parsed = provider === "deepseek" ? parseDeepSeekBalance(result.json) : parseMoonshotBalance(result.json)
  if (!parsed) {
    return {
      ok: false as const,
      error: { provider, message: "Balance API did not return an available balance; using any manual fallback." },
    }
  }
  return {
    ok: true as const,
    balance: {
      provider,
      label: provider === "moonshot" ? "moon" : provider,
      amount: parsed.amount,
      unit: parsed.unit,
      source: `${provider} API (${key.name})`,
      live: true,
      checkedAt: input.now.toISOString(),
    } satisfies CodeGoblinBalanceEntry,
  }
}

async function fetchBalance(input: {
  fetch: FetchLike
  endpoint: string
  key: string
  timeoutMs: number
}) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs)
  const result = await Promise.race([
    input
      .fetch(input.endpoint, {
        signal: controller.signal,
        headers: { authorization: `Bearer ${input.key}` },
      })
      .then(async (response) => ({ response, ...(response.ok && { json: await readLimitedJson(response) }) }))
      .catch((error) => ({ error })),
    new Promise<{ error: Error }>((resolve) =>
      controller.signal.addEventListener("abort", () => resolve({ error: new Error("Balance request timed out") }), {
        once: true,
      }),
    ),
  ])
  clearTimeout(timeout)
  return result
}

async function readLimitedJson(response: Response) {
  const limit = 1_048_576
  const size = Number(response.headers.get("content-length"))
  if (Number.isFinite(size) && size > limit) return
  if (!response.body) return
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const chunk = await reader.read()
    if (chunk.done) break
    total += chunk.value.byteLength
    if (total > limit) {
      await reader.cancel()
      return
    }
    chunks.push(chunk.value)
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown
}

function parseDeepSeekBalance(value: unknown) {
  const root = asRecord(value)
  const infos = Array.isArray(root?.balance_infos) ? root.balance_infos.map(asRecord) : []
  const item =
    infos.find((entry) => stringValue(entry?.currency)?.toUpperCase() === "USD") ??
    infos.find((entry) => parseAmount(entry?.total_balance ?? entry?.available_balance) !== undefined)
  const amount = parseAmount(item?.total_balance ?? item?.available_balance ?? item?.granted_balance)
  if (amount === undefined) return
  return { amount, unit: stringValue(item?.currency)?.toUpperCase() ?? "USD" }
}

function parseMoonshotBalance(value: unknown) {
  const root = asRecord(value)
  const data = asRecord(root?.data) ?? root
  const amount = parseAmount(
    data?.available_balance ?? data?.balance ?? data?.total_balance ?? data?.cash_balance ?? data?.voucher_balance,
  )
  if (amount === undefined) return
  return { amount, unit: stringValue(data?.currency)?.toUpperCase() ?? "USD" }
}

function selectedBalanceProvider(input: { providerID?: string; modelID?: string }) {
  const providerID = input.providerID?.toLowerCase()
  const modelID = input.modelID?.toLowerCase()
  if (providerID === "deepseek" || modelID?.includes("deepseek")) return "deepseek" as const
  if (
    providerID === "moonshot" ||
    providerID === "kimi" ||
    modelID?.includes("moonshot") ||
    modelID?.includes("kimi")
  ) {
    return "moonshot" as const
  }
}

/** Below this much remaining, the footer starts showing when the window resets. */
const FOOTER_RESET_BELOW = 15

function formatFooter(input: {
  balances?: readonly CodeGoblinBalanceEntry[]
  quotas?: readonly CliAgentQuota[]
  quotaStatuses?: readonly { providerID: string; available: boolean }[]
  spent?: number
  providerID?: string
  modelID?: string
}) {
  const balances = input.balances ?? []
  const providerQuota = input.quotas?.find((item) => item.providerID === input.providerID)
  if (providerQuota?.windows.length) {
    return providerQuota.windows
      .map((window) => {
        const left = Math.max(0, Math.round(100 - window.usedPercentage))
        // The reset time is what you need only when a window is nearly spent.
        // The rest of the time it is the longest thing on the line and pushes
        // the two percentages — the part you actually read — apart.
        const reset = left <= FOOTER_RESET_BELOW && window.resetsAt ? ` (${window.resetsAt})` : ""
        return `${window.label} ${left}% left${reset}`
      })
      .join(" · ")
  }
  const quotaStatus = input.quotaStatuses?.find((item) => item.providerID === input.providerID)
  if (quotaStatus && !quotaStatus.available) return "usage unavailable"
  const selected = selectedBalanceProvider(input)
  if (selected) {
    const providerBalance = balances.find((entry) => entry.provider === selected)
    if (providerBalance) {
      const tag = providerBalance.live ? "live" : "manual"
      return `${providerBalance.label} ${formatAmount(providerBalance.amount, providerBalance.unit)} left · ${tag}`
    }
    // No balance endpoint for this provider: show nothing. The footer already
    // displays exact session spend, so a "~$X spent · est" here was redundant.
    return
  }
  const hoard = balances.find((entry) => entry.provider === "hoard")
  if (hoard) return `hoard ${formatAmount(Math.max(0, hoard.amount - (input.spent ?? 0)), hoard.unit)} left · manual`
}

async function loadLocalEnv(root: string) {
  const result: Env = {}
  const files = envFilesUp(path.resolve(root || process.cwd()))
  for (const file of files) {
    const text = await fs.readFile(file, "utf8").catch(() => "")
    for (const line of text.split(/\r?\n/)) {
      const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line)
      if (!match || result[match[1]]) continue
      result[match[1]] = unquoteEnv(match[2])
    }
  }
  return result
}

function envFilesUp(root: string) {
  const parents: string[] = []
  let current = root
  for (;;) {
    parents.push(current)
    const parent = path.dirname(current)
    if (parent === current || current === os.homedir()) break
    current = parent
  }
  return parents.flatMap((directory) => [path.join(directory, ".env.local"), path.join(directory, ".env")])
}

function firstValue(env: Env, names: readonly string[]) {
  return names
    .map((name) => (env[name]?.trim() ? { name, value: env[name]!.trim() } : undefined))
    .filter((item): item is { name: string; value: string } => Boolean(item))[0]
}

function parseAmount(value: unknown) {
  if (typeof value !== "string" && typeof value !== "number") return
  const amount = Number(String(value).replace(/[$,]/g, "").trim())
  if (!Number.isFinite(amount) || amount < 0) return
  return amount
}

function formatAmount(amount: number, unit: string) {
  const normalized = amount
    .toFixed(amount < 10 && Math.round(amount * 100) !== amount * 100 ? 5 : 2)
    .replace(/0+$/, "")
    .replace(/\.$/, "")
  if (unit.toUpperCase() === "USD") return `$${normalized}`
  return `${normalized} ${unit}`
}

function unquoteEnv(value: string) {
  const trimmed = value.trim()
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null) return
  return value as Record<string, unknown>
}

function stringValue(value: unknown) {
  if (typeof value !== "string") return
  return value
}
