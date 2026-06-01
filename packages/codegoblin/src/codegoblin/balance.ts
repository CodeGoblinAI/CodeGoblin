import fs from "fs/promises"
import os from "os"
import path from "path"

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

const PROVIDERS = ["deepseek", "moonshot"] as const
const MANUAL_BALANCE_ENV = {
  hoard: ["CODEGOBLIN_TOKEN_HOARD_USD"],
  deepseek: ["CODEGOBLIN_DEEPSEEK_BALANCE_USD", "CODEGOBLIN_DEEPSEEK_CREDITS_USD", "DEEPSEEK_BALANCE_USD"],
  moonshot: ["CODEGOBLIN_MOONSHOT_BALANCE_USD", "CODEGOBLIN_MOONSHOT_CREDITS_USD", "MOONSHOT_BALANCE_USD", "KIMI_BALANCE_USD"],
} satisfies Record<CodeGoblinBalanceProvider, readonly string[]>

const API_KEY_ENV = {
  deepseek: ["DEEPSEEK_API_KEY", "CODEGOBLIN_DEEPSEEK_API_KEY"],
  moonshot: ["MOONSHOT_API_KEY", "KIMI_API_KEY", "CODEGOBLIN_MOONSHOT_API_KEY"],
} satisfies Record<Exclude<CodeGoblinBalanceProvider, "hoard">, readonly string[]>

export const CodeGoblinBalance = {
  async resolve(input: { cwd: string; env?: Env; fetch?: FetchLike; now?: Date }) {
    const env = { ...process.env, ...(await loadLocalEnv(input.cwd)), ...(input.env ?? {}) }
    const configured = configuredBalances(env)
    const live = await liveBalances({ env, fetch: input.fetch ?? fetch, now: input.now ?? new Date() })
    const byProvider = new Map<CodeGoblinBalanceProvider, CodeGoblinBalanceEntry>()
    for (const entry of configured) byProvider.set(entry.provider, entry)
    for (const entry of live.balances) byProvider.set(entry.provider, entry)
    return {
      balances: [...byProvider.values()],
      errors: live.errors,
    }
  },
  configured: configuredBalances,
  formatFooter,
  selectedBalanceProvider,
  parseDeepSeekBalance,
  parseMoonshotBalance,
}

function configuredBalances(env: Env): CodeGoblinBalanceEntry[] {
  return (["hoard", ...PROVIDERS] as const)
    .flatMap((provider) => {
      const match = firstValue(env, MANUAL_BALANCE_ENV[provider])
      const amount = parseAmount(match?.value)
      if (amount === undefined || !match) return []
      return [{
        provider,
        label: provider === "moonshot" ? "moon" : provider,
        amount,
        unit: "USD",
        source: match.name,
        live: false,
      } satisfies CodeGoblinBalanceEntry]
    })
}

async function liveBalances(input: { env: Env; fetch: FetchLike; now: Date }) {
  const results = await Promise.all(PROVIDERS.map((provider) => liveBalance(provider, input)))
  return {
    balances: results.flatMap((result) => (result.ok ? [result.balance] : [])),
    errors: results.flatMap((result) => (result.ok ? [] : [result.error])),
  }
}

async function liveBalance(
  provider: Exclude<CodeGoblinBalanceProvider, "hoard">,
  input: { env: Env; fetch: FetchLike; now: Date },
) {
  const key = firstValue(input.env, API_KEY_ENV[provider])
  if (!key) return { ok: false as const, error: { provider, message: "No API key configured." } }

  const endpoint =
    provider === "deepseek" ? "https://api.deepseek.com/user/balance" : "https://api.moonshot.cn/v1/users/me/balance"
  const response = await input
    .fetch(endpoint, {
      headers: {
        authorization: `Bearer ${key.value}`,
      },
    })
    .catch((error) => ({ error }))

  if ("error" in response) {
    return {
      ok: false as const,
      error: { provider, message: "Balance API is unavailable; using any manual fallback." },
    }
  }
  if (!response.ok) {
    return {
      ok: false as const,
      error: { provider, message: `Balance API returned HTTP ${response.status}; using any manual fallback.` },
    }
  }

  const json = await response.json().catch(() => undefined)
  const parsed = provider === "deepseek" ? parseDeepSeekBalance(json) : parseMoonshotBalance(json)
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
  if (providerID === "moonshot" || providerID === "kimi" || modelID?.includes("moonshot") || modelID?.includes("kimi")) {
    return "moonshot" as const
  }
}

function formatFooter(input: {
  balances?: readonly CodeGoblinBalanceEntry[]
  spent?: number
  providerID?: string
  modelID?: string
}) {
  const balances = input.balances ?? []
  const selected = selectedBalanceProvider(input)
  if (selected) {
    const providerBalance = balances.find((entry) => entry.provider === selected)
    if (providerBalance) {
      const tag = providerBalance.live ? "live" : "manual"
      return `${providerBalance.label} ${formatAmount(providerBalance.amount, providerBalance.unit)} left · ${tag}`
    }
    // No balance endpoint for this provider: fall back to a running session-spend estimate.
    if (input.spent !== undefined && input.spent > 0) return `~${formatAmount(input.spent, "USD")} spent · est`
    return
  }
  const hoard = balances.find((entry) => entry.provider === "hoard")
  if (hoard) return `hoard ${formatAmount(Math.max(0, hoard.amount - (input.spent ?? 0)), hoard.unit)} left · manual`
  if (input.spent !== undefined && input.spent > 0) return `~${formatAmount(input.spent, "USD")} spent · est`
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
  const normalized = amount.toFixed(amount < 10 && Math.round(amount * 100) !== amount * 100 ? 5 : 2).replace(/0+$/, "").replace(/\.$/, "")
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