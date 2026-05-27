import { describe, expect, test } from "bun:test"
import os from "os"
import path from "path"
import { CodeGoblinBalance } from "@/codegoblin/balance"

describe("CodeGoblin balance display", () => {
  test("formats DeepSeek and Moonshot manual balances without rounding away small credits", () => {
    const balances = CodeGoblinBalance.configured({
      CODEGOBLIN_DEEPSEEK_BALANCE_USD: "2.12",
      CODEGOBLIN_MOONSHOT_BALANCE_USD: "2.22376",
    })

    expect(CodeGoblinBalance.formatFooter({ balances })).toBe("hoard deepseek $2.12 · moon $2.22376")
  })

  test("ignores invalid manual balances instead of surfacing a giant error", () => {
    const balances = CodeGoblinBalance.configured({
      CODEGOBLIN_DEEPSEEK_BALANCE_USD: "nope",
      CODEGOBLIN_MOONSHOT_BALANCE_USD: "-1",
    })

    expect(balances).toEqual([])
    expect(CodeGoblinBalance.formatFooter({ balances })).toBe("hoard local")
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