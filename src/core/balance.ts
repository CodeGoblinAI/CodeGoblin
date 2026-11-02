/** Account balances are provider snapshots, not session cost or subscription quota. */
export type Balance = {
  provider: string
  state: "ready" | "unavailable" | "unsupported" | "disconnected"
  checkedAt: number
  detail: string
  resetsAt?: number
  entries: { label: string; amount: string; unit: string }[]
}

const ENDPOINTS: Record<string, string> = {
  deepseek: "https://api.deepseek.com/user/balance",
  tripo: "https://openapi.tripo3d.ai/v3/account/balance",
  elevenlabs: "https://api.elevenlabs.io/v1/user/subscription",
  // https://platform.kimi.ai/docs/api/balance - USD; keys from the .com platform are a different account.
  moonshotai: "https://api.moonshot.ai/v1/users/me/balance",
  // https://platform.experientiallabs.ai/llms.txt - total_credits minus total_usage, in USD, with an ordinary key.
  explabs: "https://api.experientiallabs.ai/api/v1/credits",
}

/** Experiential Labs' per-key figures: spend today, this week and month, and a daily cap when one is set. */
const EXPLABS_KEY = "https://api.experientiallabs.ai/api/v1/key"

/**
 * Providers that have no balance API at all, with where to look instead. Said
 * plainly, rather than "not supported yet", which reads as coming soon.
 */
const NO_API: Record<string, string> = {
  zai: "Z.ai has no balance API for pay-as-you-go keys; check the billing page at https://z.ai",
  xiaomi: "Xiaomi MiMo has no balance API; check the Balance page at https://platform.xiaomimimo.com",
  meta: "Meta has no balance API; check your account in Meta's developer dashboard",
}

export async function fetchBalance(
  provider: string,
  key?: string,
  request: (url: string, init: RequestInit) => Promise<Response> = fetch,
): Promise<Balance> {
  const snapshot: Balance = { provider, state: "unavailable", checkedAt: Date.now(), detail: "Balance unavailable; not zero", entries: [] }
  // Never take an endpoint from the browser, model, config or an error response.
  const endpoint = Object.hasOwn(ENDPOINTS, provider) ? ENDPOINTS[provider] : undefined
  if (!endpoint && Object.hasOwn(NO_API, provider)) return { ...snapshot, state: "unsupported", detail: NO_API[provider]! }
  if (!endpoint) return { ...snapshot, state: "unsupported", detail: "Live balance not supported for this provider yet" }
  if (!key?.trim()) return { ...snapshot, state: "disconnected", detail: "Connect this provider to check its balance" }
  try {
    const response = await request(endpoint, {
      method: "GET", headers: { ...(provider === "elevenlabs" ? { "xi-api-key": key } : { authorization: "Bearer " + key }), accept: "application/json" },
      redirect: "error", signal: AbortSignal.timeout(5000),
    })
    if (!response.ok) {
      await response.body?.cancel()
      return { ...snapshot, checkedAt: Date.now(), detail: response.status === 401 || response.status === 403
        ? "Balance authorization refused; check the provider key and its permissions"
        : "Balance request failed (HTTP " + response.status + "); try again" }
    }
    if (!response.body) throw new Error("Missing response body")
    const parsed = parseBalance(provider, JSON.parse(await readCapped(response)))
    // Experiential Labs: the key's own spend and daily cap too, best effort - the balance stands without it.
    if (provider === "explabs") parsed.entries.push(...await explabsKeyEntries(key, request))
    return { ...snapshot, ...parsed, state: "ready", checkedAt: Date.now() }
  } catch {
    // Provider bodies and exception text may echo a key; expose neither.
    return { ...snapshot, checkedAt: Date.now(), detail: "Balance unavailable: timeout, network error or invalid provider response; try again" }
  }
}

/** A JSON body read whole, but never more than 64 KB of it. */
async function readCapped(response: Response): Promise<string> {
  if (!response.body) throw new Error("Missing response body")
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let text = ""
  let bytes = 0
  try {
    for (;;) {
      const part = await reader.read()
      if (part.done) break
      bytes += part.value.byteLength
      if (bytes > 65_536) throw new Error("Oversized balance response")
      text += decoder.decode(part.value, { stream: true })
    }
    return text + decoder.decode()
  } finally {
    await reader.cancel().catch(() => {})
  }
}

const usd = (value: number) => (Math.round(value * 100) / 100).toFixed(2)

async function explabsKeyEntries(key: string, request: (url: string, init: RequestInit) => Promise<Response>): Promise<{ label: string; amount: string; unit: string }[]> {
  try {
    const response = await request(EXPLABS_KEY, { method: "GET", headers: { authorization: "Bearer " + key, accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(5000) })
    if (!response.ok) { await response.body?.cancel(); return [] }
    const data = record(record(JSON.parse(await readCapped(response))).data)
    const number = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined)
    const entries: { label: string; amount: string; unit: string }[] = []
    for (const [label, field] of [["This key today", "usage_daily"], ["This key this month", "usage_monthly"]] as const) {
      const value = number(data[field])
      if (value !== undefined) entries.push({ label, amount: usd(value), unit: "USD" })
    }
    const limit = number(data.limit)
    const left = number(data.limit_remaining)
    entries.push(limit === undefined
      ? { label: "Daily limit", amount: "none", unit: "set on this key" }
      : { label: "Daily limit left", amount: usd(left ?? 0), unit: "of " + usd(limit) + " USD" })
    return entries
  } catch {
    return []
  }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid balance object")
  return value as Record<string, unknown>
}

function amount(value: unknown): string {
  if (typeof value !== "number" && typeof value !== "string") throw new Error("Invalid amount")
  const text = String(value)
  if (text.length > 64 || !/^-?\d+(?:\.\d+)?$/.test(text) || !Number.isFinite(Number(text))) throw new Error("Invalid amount")
  return text
}

function parseBalance(provider: string, input: unknown) {
  const raw = record(input)
  if (provider === "elevenlabs") {
    const count = (value: unknown) => {
      if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error("Invalid subscription count")
      return value
    }
    const used = count(raw.character_count)
    const limit = count(raw.character_limit)
    const resetsAt = raw.next_character_count_reset_unix == null ? undefined : count(raw.next_character_count_reset_unix)
    return { detail: "ElevenLabs subscription character fields (API quota, not a cash balance)", resetsAt, entries: [
      { label: "Used", amount: String(used), unit: "characters" },
      { label: "Included limit", amount: String(limit), unit: "characters" },
      { label: "Included remaining", amount: String(Math.max(0, limit - used)), unit: "characters" },
    ] }
  }
  if (provider === "moonshotai") {
    if (raw.code !== 0 || raw.status !== true) throw new Error("Provider refused balance")
    const data = record(raw.data)
    const available = amount(data.available_balance)
    // Cash can go below zero - money owed - and then only vouchers are spendable.
    const cash = amount(data.cash_balance)
    return { detail: Number(available) > 0 ? "Available for API calls (provider)" + (Number(cash) < 0 ? "; cash balance is owed" : "") : "insufficient balance for API calls (provider)", entries: [
      { label: "Available", amount: available, unit: "USD" },
      { label: "Vouchers", amount: amount(data.voucher_balance), unit: "USD" },
      { label: "Cash", amount: cash, unit: "USD" },
    ] }
  }
  if (provider === "explabs") {
    const data = record(raw.data)
    const credits = Number(amount(data.total_credits))
    const used = Number(amount(data.total_usage))
    const left = credits - used
    return { detail: left > 0 ? "Credits left for API calls (provider)" : "no credits left for API calls (provider) - top up at https://platform.experientiallabs.ai/credits", entries: [
      { label: "Credits left", amount: usd(left), unit: "USD" },
      { label: "Total credits", amount: usd(credits), unit: "USD" },
      { label: "Used", amount: usd(used), unit: "USD" },
    ] }
  }
  if (provider === "tripo") {
    if (raw.code !== 0) throw new Error("Provider refused balance")
    const data = record(raw.data)
    return { detail: "Tripo API credits (not USD or Studio subscription quota)", entries: [
      { label: "Available", amount: amount(data.balance), unit: "credits" },
      { label: "Frozen / reserved", amount: amount(data.frozen), unit: "credits" },
    ] }
  }
  if (typeof raw.is_available !== "boolean" || !Array.isArray(raw.balance_infos) || !raw.balance_infos.length || raw.balance_infos.length > 2) throw new Error("Invalid DeepSeek balance")
  const entries = raw.balance_infos.flatMap((item: unknown) => {
    const info = record(item)
    if (info.currency !== "USD" && info.currency !== "CNY") throw new Error("Unknown balance currency")
    return [
      { label: "Total", amount: amount(info.total_balance), unit: info.currency },
      { label: "Granted", amount: amount(info.granted_balance), unit: info.currency },
      { label: "Topped up", amount: amount(info.topped_up_balance), unit: info.currency },
    ]
  })
  if (new Set(entries.map((entry) => entry.unit)).size !== raw.balance_infos.length) throw new Error("Duplicate balance currency")
  return { detail: raw.is_available ? "Available for API calls (provider)" : "insufficient balance for API calls (provider)", entries }
}

export function balanceRows(snapshot: Balance): [string, string][] {
  return [
    ["provider balance", snapshot.provider + " · " + snapshot.state],
    ["balance status", snapshot.detail],
    ...snapshot.entries.map((entry): [string, string] => [entry.label, entry.amount + " " + entry.unit]),
    ...(snapshot.provider === "elevenlabs" && snapshot.state === "ready" ? [["quota reset", snapshot.resetsAt === undefined ? "unavailable; not zero" : new Date(snapshot.resetsAt * 1000).toLocaleString()] as [string, string]] : []),
    ["checked", new Date(snapshot.checkedAt).toLocaleString()],
    ["freshness", "snapshot only; reopen to refresh"],
  ]
}
