import { describe, expect, test } from "bun:test"
import { fetchBalance, balanceRows } from "../src/core/balance"
import { runCommand } from "../src/core/commands"

const deepseek = { is_available: true, balance_infos: [
  { currency: "USD", total_balance: "12.34", granted_balance: "2.00", topped_up_balance: "10.34" },
] }

/** Exercise real HTTP bodies, errors and redirects without using account credentials. */
async function withServer(body: unknown, status = 200, headers: Record<string, string> = {}) {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    expect(request.method).toBe("GET")
    expect(request.headers.get("authorization")).toBe("Bearer fixture-key")
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers })
  } })
  const transport = (url: string, init: RequestInit) => {
    expect(["https://api.deepseek.com/user/balance", "https://openapi.tripo3d.ai/v3/account/balance", "https://api.moonshot.ai/v1/users/me/balance"]).toContain(url)
    expect(init.redirect).toBe("error")
    return fetch(server.url, init)
  }
  return { server, transport }
}

describe("account balances", () => {
  test("ElevenLabs subscription quota uses xi-api-key, not bearer auth, and is not money", async () => {
    let payload: unknown = { character_count: 250, character_limit: 1000, next_character_count_reset_unix: 2000000000 }
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
      expect(request.headers.get("xi-api-key")).toBe("fixture-key")
      expect(request.headers.has("authorization")).toBe(false)
      return Response.json(payload)
    } })
    const transport = (url: string, init: RequestInit) => {
      expect(url).toBe("https://api.elevenlabs.io/v1/user/subscription")
      expect(init.redirect).toBe("error")
      return fetch(server.url, init)
    }
    try {
      const result = await fetchBalance("elevenlabs", "fixture-key", transport)
      expect(result.entries.map((entry) => entry.amount)).toEqual(["250", "1000", "750"])
      expect(result.entries.every((entry) => entry.unit === "characters")).toBe(true)
      expect(result.resetsAt).toBe(2000000000)
      expect(result.detail).toContain("not a cash balance")
      payload = { character_count: 1200, character_limit: 1000, next_character_count_reset_unix: null }
      const overage = await fetchBalance("elevenlabs", "fixture-key", transport)
      expect(overage.entries[2]?.amount).toBe("0")
      expect(balanceRows(overage).find(([label]) => label === "quota reset")?.[1]).toContain("unavailable")
      for (const invalid of [-1, 1.2, "250", undefined, Number.MAX_SAFE_INTEGER + 1]) {
        payload = { character_count: invalid, character_limit: 1000 }
        expect((await fetchBalance("elevenlabs", "fixture-key", transport)).state).toBe("unavailable")
      }
    } finally { server.stop(true) }
  })
  test("unsupported and disconnected states make no request", async () => {
    const unexpected = async () => { throw new Error("must not request") }
    expect((await fetchBalance("__proto__", "fixture-key", unexpected)).state).toBe("unsupported")
    expect((await fetchBalance("claude-code", "fixture-key", unexpected)).entries).toEqual([])
    expect((await fetchBalance("deepseek", undefined, unexpected)).state).toBe("disconnected")
  })

  test("DeepSeek retains decimal precision and each currency without conversion", async () => {
    const fixture = await withServer({ ...deepseek, balance_infos: [...deepseek.balance_infos,
      { currency: "CNY", total_balance: "100.000001", granted_balance: "0", topped_up_balance: "100.000001" },
    ] })
    try {
      const result = await fetchBalance("deepseek", "fixture-key", fixture.transport)
      expect(result.state).toBe("ready")
      expect(result.entries).toHaveLength(6)
      expect(result.entries[3]).toEqual({ label: "Total", amount: "100.000001", unit: "CNY" })
      expect(balanceRows(result).at(-1)?.[1]).toContain("snapshot")
      expect(result.checkedAt).toBeLessThanOrEqual(Date.now())
    } finally { fixture.server.stop(true) }
  })

  test("zero and insufficient funds are valid, not unavailable", async () => {
    const fixture = await withServer({ is_available: false, balance_infos: [
      { currency: "USD", total_balance: "0.00", granted_balance: "0.00", topped_up_balance: "0.00" },
    ] })
    try {
      const result = await fetchBalance("deepseek", "fixture-key", fixture.transport)
      expect(result.state).toBe("ready")
      expect(result.entries[0]?.amount).toBe("0.00")
      expect(result.detail).toContain("insufficient")
    } finally { fixture.server.stop(true) }
  })

  test("Kimi reports available, voucher and cash USD, and owed cash is not hidden", async () => {
    const fixture = await withServer({ code: 0, data: { available_balance: 49.58894, voucher_balance: 46.58893, cash_balance: 3.00001 }, scode: "0x0", status: true })
    try {
      const result = await fetchBalance("moonshotai", "fixture-key", fixture.transport)
      expect(result.state).toBe("ready")
      expect(result.entries).toEqual([
        { label: "Available", amount: "49.58894", unit: "USD" },
        { label: "Vouchers", amount: "46.58893", unit: "USD" },
        { label: "Cash", amount: "3.00001", unit: "USD" },
      ])
      expect(result.detail).toBe("Available for API calls (provider)")
    } finally { fixture.server.stop(true) }
    const owed = await withServer({ code: 0, data: { available_balance: 5, voucher_balance: 5, cash_balance: -2.5 }, scode: "0x0", status: true })
    try {
      const result = await fetchBalance("moonshotai", "fixture-key", owed.transport)
      expect(result.entries[2]).toEqual({ label: "Cash", amount: "-2.5", unit: "USD" })
      expect(result.detail).toContain("cash balance is owed")
    } finally { owed.server.stop(true) }
    const empty = await withServer({ code: 0, data: { available_balance: 0, voucher_balance: 0, cash_balance: 0 }, scode: "0x0", status: true })
    try { expect((await fetchBalance("moonshotai", "fixture-key", empty.transport)).detail).toContain("insufficient") } finally { empty.server.stop(true) }
    const refused = await withServer({ code: 1, data: {}, status: false })
    try { expect((await fetchBalance("moonshotai", "fixture-key", refused.transport)).state).toBe("unavailable") } finally { refused.server.stop(true) }
  })

  test("Tripo keeps frozen credits separate from available credits and dollars", async () => {
    const fixture = await withServer({ code: 0, data: { balance: 100, frozen: 20 } })
    try {
      const result = await fetchBalance("tripo", "fixture-key", fixture.transport)
      expect(result.entries).toEqual([
        { label: "Available", amount: "100", unit: "credits" },
        { label: "Frozen / reserved", amount: "20", unit: "credits" },
      ])
      expect(result.detail).toContain("not USD")
    } finally { fixture.server.stop(true) }
  })

  for (const [label, body, status] of [
    ["denied", "fixture-key secret body", 403],
    ["server error", "fixture-key secret body", 500],
    ["bad JSON", "fixture-key", 200],
    ["missing amounts", { is_available: true, balance_infos: [{ currency: "USD" }] }, 200],
    ["bad amount", { code: 0, data: { balance: "Infinity", frozen: 0 } }, 200],
    ["duplicate currency", { ...deepseek, balance_infos: [...deepseek.balance_infos, ...deepseek.balance_infos] }, 200],
    ["oversized", "x".repeat(70_000), 200],
  ] as const) {
    test(label + " never reports zero or echoes secrets", async () => {
      const fixture = await withServer(body, status)
      try {
        const result = await fetchBalance(label === "bad amount" ? "tripo" : "deepseek", "fixture-key", fixture.transport)
        expect(result.state).toBe("unavailable")
        expect(result.entries).toEqual([])
        expect(JSON.stringify(result)).not.toContain("fixture-key")
      } finally { fixture.server.stop(true) }
    })
  }

  test("redirects cannot forward credentials to another host", async () => {
    let reached = false
    const target = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { reached = true; return Response.json(deepseek) } })
    const fixture = await withServer("", 302, { location: target.url.toString() })
    try {
      expect((await fetchBalance("deepseek", "fixture-key", fixture.transport)).state).toBe("unavailable")
      expect(reached).toBe(false)
    } finally { fixture.server.stop(true); target.stop(true) }
  })

  test("a stalled response is bounded by the request timeout", async () => {
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
      return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{')) } }))
    } })
    const started = Date.now()
    try {
      const result = await fetchBalance("deepseek", "fixture-key", (_, init) => fetch(server.url, init))
      expect(result.state).toBe("unavailable")
      expect(Date.now() - started).toBeLessThan(7000)
    } finally { server.stop(true) }
  }, 10_000)

  test("commands carry the selected provider and aliases match", () => {
    expect(runCommand("/balance")).toEqual({ kind: "balance", provider: undefined })
    expect(runCommand("/credits tripo")).toEqual(runCommand("/balance tripo"))
  })
})
