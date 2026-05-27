import { describe, expect, test } from "bun:test"
import os from "os"
import path from "path"
import { CodeGoblinBalance } from "@/codegoblin/balance"

describe("CodeGoblin balance display", () => {
  test("formats only the selected provider balance without rounding away small credits", () => {
    const balances = CodeGoblinBalance.configured({
      CODEGOBLIN_DEEPSEEK_BALANCE_USD: "2.12",
      CODEGOBLIN_MOONSHOT_BALANCE_USD: "2.22376",
    })

    expect(CodeGoblinBalance.formatFooter({ balances, providerID: "deepseek", modelID: "deepseek-chat" })).toBe(
      "deepseek $2.12 left",
    )
    expect(CodeGoblinBalance.formatFooter({ balances, providerID: "google", modelID: "gemini-2.5-pro" })).toBeUndefined()
    expect(CodeGoblinBalance.formatFooter({ balances, providerID: "moonshot", modelID: "kimi-k2" })).toBe(
      "moon $2.22376 left",
    )
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

    expect(CodeGoblinBalance.formatFooter({ balances, spent: 1.25 })).toBe("hoard $3.75 left")
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
})