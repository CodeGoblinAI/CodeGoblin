export type UsageTokens = {
  total: number
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
}

export type UsageTotals = {
  tokens: UsageTokens
  spend: number
}

export type UsageBalance = {
  provider: string
  label: string
  amount: number
  unit: string
  source: string
  live: boolean
  checkedAt?: string
}

export type UsageQuota = {
  providerID: string
  label: string
  usedPercentage: number
  remainingPercentage: number
  resetsAt?: string
  checkedAt?: string
}

export type UsageSnapshot = {
  session?: UsageTotals
  aggregate: UsageTotals
  balances: UsageBalance[]
  quotas: UsageQuota[]
  errors: { provider: string; message: string }[]
  refreshedAt: string
}

export type UsageSessionLike = {
  id: string
  cost?: number
  tokens?: {
    input: number
    output: number
    reasoning: number
    cache: { read: number; write: number }
  }
}

export type UsageQuotaSource = {
  providerID: string
  checkedAt?: string
  windows: readonly {
    label: string
    usedPercentage: number
    resetsAt?: string
  }[]
}

export function normalizeUsageQuotas(sources: readonly UsageQuotaSource[]): UsageQuota[] {
  return sources.flatMap((source) =>
    source.windows.map((window) => {
      const usedPercentage = Math.min(100, Math.max(0, window.usedPercentage))
      return {
        providerID: source.providerID,
        label: `${source.providerID} ${window.label}`,
        usedPercentage,
        remainingPercentage: 100 - usedPercentage,
        ...(window.resetsAt && { resetsAt: window.resetsAt }),
        ...(source.checkedAt && { checkedAt: source.checkedAt }),
      }
    }),
  )
}

export function summarizeUsage(sessions: readonly UsageSessionLike[], sessionID?: string): UsageSnapshot {
  const totals = (items: readonly UsageSessionLike[]): UsageTotals => {
    const tokens = items.reduce(
      (sum, item) => {
        const input = item.tokens?.input ?? 0
        const output = item.tokens?.output ?? 0
        const reasoning = item.tokens?.reasoning ?? 0
        const cacheRead = item.tokens?.cache.read ?? 0
        const cacheWrite = item.tokens?.cache.write ?? 0
        sum.input += input
        sum.output += output
        sum.reasoning += reasoning
        sum.cacheRead += cacheRead
        sum.cacheWrite += cacheWrite
        sum.total += input + output + reasoning + cacheRead + cacheWrite
        return sum
      },
      { total: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    )
    return { tokens, spend: items.reduce((sum, item) => sum + (item.cost ?? 0), 0) }
  }

  const session = sessionID ? sessions.find((item) => item.id === sessionID) : undefined
  return {
    session: session ? totals([session]) : undefined,
    aggregate: totals(sessions),
    balances: [],
    quotas: [],
    errors: [],
    refreshedAt: new Date().toISOString(),
  }
}
