import { describe, expect, test } from "bun:test"
import { APICallError } from "ai"
import { ProviderError } from "@/provider/error"
import { ProviderID } from "@/provider/schema"

const body = JSON.stringify({
  type: "error",
  error: {
    type: "FreeTierError",
    message: "Error from provider (Console): OpenCode's free tier can only be used from within OpenCode",
  },
})

describe("Zen free-tier restrictions", () => {
  test("the actual server response gives CodeGoblin-specific guidance", () => {
    const result = ProviderError.parseStreamError(body)
    expect(result?.type).toBe("api_error")
    expect(result?.message).toContain("Updating OpenCode does not update CodeGoblin")
    expect(result?.responseBody).toBe(body)
    if (result?.type === "api_error") expect(result.isRetryable).toBe(false)
  })

  test("HTTP rejections are not retried and retain the original response", () => {
    const result = ProviderError.parseAPICallError({
      providerID: ProviderID.make("opencode"),
      error: new APICallError({
        message: "Forbidden",
        url: "https://opencode.ai/zen/v1/chat/completions",
        requestBodyValues: {},
        statusCode: 403,
        responseBody: body,
        isRetryable: true,
      }),
    })
    expect(result.message).toContain("free-tier client policy")
    expect(result.responseBody).toBe(body)
    if (result.type === "api_error") expect(result.isRetryable).toBe(false)
  })

  test("version errors explain which application is affected", () => {
    const result = ProviderError.parseStreamError({
      type: "error",
      error: { type: "FreeTierError", message: "Please update OpenCode to use this free model" },
    })
    expect(result?.message).toContain("CodeGoblin")
  })

  test("the reported minimum-version HTTP error recommends updating CodeGoblin", () => {
    const responseBody = JSON.stringify({
      error: {
        type: "UpgradeRequiredError",
        message: "Error from provider (Console): OpenCode 1.18.0 or newer is required to use the free tier",
      },
    })
    const result = ProviderError.parseAPICallError({
      providerID: ProviderID.make("opencode"),
      error: new APICallError({
        message: "Upgrade Required",
        url: "https://opencode.ai/zen/v1/responses",
        requestBodyValues: {},
        statusCode: 426,
        responseBody,
        isRetryable: true,
      }),
    })
    expect(result.message).toContain("Update CodeGoblin")
    expect(result.responseBody).toBe(responseBody)
    if (result.type === "api_error") expect(result.isRetryable).toBe(false)
  })

  test("another provider's OpenCode error is not rewritten", () => {
    const result = ProviderError.parseAPICallError({
      providerID: ProviderID.make("openai"),
      error: new APICallError({
        message: "Please update OpenCode",
        url: "https://api.openai.com/v1/responses",
        requestBodyValues: {},
        statusCode: 426,
        isRetryable: false,
      }),
    })
    expect(result.message).toBe("Please update OpenCode")
  })

  test("unrelated free-tier limits are not rewritten", () => {
    expect(
      ProviderError.parseStreamError({
        type: "error",
        error: { type: "FreeTierError", message: "Daily limit exceeded" },
      }),
    ).toBeUndefined()
  })

  test("unrelated streaming errors mentioning OpenCode retain their normal handling", () => {
    const result = ProviderError.parseStreamError({ type: "error", error: { code: "invalid_prompt", message: "Please update OpenCode" } })
    expect(result?.message).toBe("Please update OpenCode")
  })
})
