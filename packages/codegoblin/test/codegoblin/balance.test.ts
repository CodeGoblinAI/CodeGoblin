import { describe, expect, test } from "bun:test"
import os from "os"
import path from "path"
import fs from "fs/promises"
import { CodeGoblinBalance } from "@/codegoblin/balance"

describe("CodeGoblin balance display", () => {
  test("formats only the selected provider balance without rounding away small credits", () => {
    const balances = CodeGoblinBalance.configured({
      CODEGOBLIN_DEEPSEEK_BALANCE_USD: "2.12",
      CODEGOBLIN_MOONSHOT_BALANCE_USD: "2.22376",
    })

    expect(CodeGoblinBalance.formatFooter({ balances, providerID: "deepseek", modelID: "deepseek-chat" })).toBe(
      "deepseek $2.12 left · manual",
    )
    expect(
      CodeGoblinBalance.formatFooter({ balances, providerID: "google", modelID: "gemini-2.5-pro" }),
    ).toBeUndefined()
    expect(CodeGoblinBalance.formatFooter({ balances, providerID: "moonshot", modelID: "kimi-k2" })).toBe(
      "moon $2.22376 left · manual",
    )
  })

  test("tags live balances and falls back to a running spend estimate", () => {
    const live = [
      {
        provider: "deepseek" as const,
        label: "deepseek",
        amount: 2.12,
        unit: "USD",
        source: "deepseek API",
        live: true,
      },
    ]

    expect(CodeGoblinBalance.formatFooter({ balances: live, providerID: "deepseek", modelID: "deepseek-chat" })).toBe(
      "deepseek $2.12 left · live",
    )
    // Provider with no balance endpoint shows nothing — the footer already
    // displays exact session spend, so a spend estimate here would be redundant.
    expect(
      CodeGoblinBalance.formatFooter({
        balances: live,
        providerID: "google",
        modelID: "gemini-2.5-flash-image",
        spent: 0.039,
      }),
    ).toBeUndefined()
  })

  test("never fabricates a balance when nothing is configured", () => {
    // No manual env and no live balances: the footer must be empty, not a made-up number.
    expect(CodeGoblinBalance.configured({})).toEqual([])
    expect(CodeGoblinBalance.formatFooter({ balances: [] })).toBeUndefined()
    expect(
      CodeGoblinBalance.formatFooter({ balances: [], providerID: "deepseek", modelID: "deepseek-chat" }),
    ).toBeUndefined()
    // Session spend alone never produces a footer — it is already shown elsewhere.
    expect(CodeGoblinBalance.formatFooter({ balances: [], spent: 0.5 })).toBeUndefined()
  })

  test("shows subscription quota instead of a meaningless zero-dollar balance", () => {
    expect(
      CodeGoblinBalance.formatFooter({
        providerID: "claude-code",
        quotas: [
          {
            providerID: "claude-code",
            checkedAt: "2026-07-20T00:00:00Z",
            windows: [
              { label: "5h", usedPercentage: 50 },
              { label: "week", usedPercentage: 20 },
            ],
          },
        ],
      }),
    ).toBe("5h 50% left · week 80% left")
  })

  test("resolve returns no balances and no fabricated numbers without keys or manual env", async () => {
    const result = await CodeGoblinBalance.resolve({
      cwd: path.join(os.tmpdir(), "codegoblin-balance-empty"),
      env: {},
      fetch: async () => {
        throw new Error("network should not be reachable without an API key")
      },
      now: new Date("2026-05-27T00:00:00.000Z"),
    })
    expect(result.balances).toEqual([])
    expect(CodeGoblinBalance.formatFooter({ balances: result.balances })).toBeUndefined()
  })

  test("ignores invalid manual balances instead of surfacing a giant error", () => {
    const balances = CodeGoblinBalance.configured({
      CODEGOBLIN_DEEPSEEK_BALANCE_USD: "nope",
      CODEGOBLIN_MOONSHOT_BALANCE_USD: "-1",
    })

    expect(balances).toEqual([])
    expect(CodeGoblinBalance.formatFooter({ balances })).toBeUndefined()
  })

  test("keeps generic hoard fallback local when no provider-specific balance is selected", () => {
    const balances = CodeGoblinBalance.configured({
      CODEGOBLIN_TOKEN_HOARD_USD: "5",
      CODEGOBLIN_DEEPSEEK_BALANCE_USD: "2.12",
    })

    expect(CodeGoblinBalance.formatFooter({ balances, spent: 1.25 })).toBe("hoard $3.75 left · manual")
  })

  test("parses live DeepSeek balance responses", () => {
    expect(
      CodeGoblinBalance.parseDeepSeekBalance({
        balance_infos: [{ currency: "USD", total_balance: "2.12" }],
      }),
    ).toEqual({ amount: 2.12, unit: "USD" })
  })

  test("parses live Moonshot balance responses", () => {
    expect(
      CodeGoblinBalance.parseMoonshotBalance({
        data: { available_balance: "2.22376", currency: "USD" },
      }),
    ).toEqual({ amount: 2.22376, unit: "USD" })
  })

  test("falls back cleanly when a provider balance API omits the remaining balance", async () => {
    const result = await CodeGoblinBalance.resolve({
      cwd: path.join(os.tmpdir(), "codegoblin-balance-test"),
      env: {
        DEEPSEEK_API_KEY: "test-key",
        CODEGOBLIN_DEEPSEEK_BALANCE_USD: "2.12",
      },
      fetch: async () => Response.json({ balance_infos: [] }),
      now: new Date("2026-05-27T00:00:00.000Z"),
    })

    expect(result.balances).toMatchObject([{ provider: "deepseek", amount: 2.12, live: false }])
    expect(result.errors.some((item) => item.provider === "deepseek")).toBe(true)
  })

  test("can disable request-selected local env discovery", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "codegoblin-balance-boundary-"))
    await Bun.write(path.join(root, ".env"), "CODEGOBLIN_TOKEN_HOARD_USD=9876")
    const result = await CodeGoblinBalance.resolve({
      cwd: root,
      env: {},
      includeLocalEnv: false,
      fetch: async () => {
        throw new Error("network should not be reachable without an API key")
      },
    })
    await fs.rm(root, { recursive: true, force: true })

    expect(result.balances.some((balance) => balance.provider === "hoard" && balance.amount === 9876)).toBe(false)
  })

  test("bounds live provider balance requests", async () => {
    const started = Date.now()
    const result = await CodeGoblinBalance.resolve({
      cwd: os.tmpdir(),
      env: { DEEPSEEK_API_KEY: "test-key" },
      includeLocalEnv: false,
      timeoutMs: 10,
      fetch: async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"balance_infos":'))
            },
          }),
        ),
    })

    expect(Date.now() - started).toBeLessThan(1_000)
    expect(result.errors.some((item) => item.provider === "deepseek")).toBe(true)
  })
})
