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
}

export async function fetchBalance(
  provider: string,
  key?: string,
  request: (url: string, init: RequestInit) => Promise<Response> = fetch,
): Promise<Balance> {
  const snapshot: Balance = { provider, state: "unavailable", checkedAt: Date.now(), detail: "Balance unavailable; not zero", entries: [] }
  // Never take an endpoint from the browser, model, config or an error response.
  const endpoint = Object.hasOwn(ENDPOINTS, provider) ? ENDPOINTS[provider] : undefined
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
      text += decoder.decode()
    } finally {
      await reader.cancel().catch(() => {})
    }
    const parsed = parseBalance(provider, JSON.parse(text))
    return { ...snapshot, ...parsed, state: "ready", checkedAt: Date.now() }
  } catch {
    // Provider bodies and exception text may echo a key; expose neither.
    return { ...snapshot, checkedAt: Date.now(), detail: "Balance unavailable: timeout, network error or invalid provider response; try again" }
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
