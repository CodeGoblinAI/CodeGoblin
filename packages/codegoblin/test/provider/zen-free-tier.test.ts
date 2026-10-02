import { describe, expect, test } from "bun:test"
import { APICallError } from "ai"
import { ProviderError } from "@/provider/error"
import { ProviderID } from "@/provider/schema"
import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import { MessageV2 } from "@/session/message-v2"

const body = JSON.stringify({
  type: "error",
  error: {
    type: "FreeTierError",
    message: "Error from provider (Console): OpenCode's free tier can only be used from within OpenCode",
  },
})

describe("Zen free-tier restrictions", () => {
  test("SDK streaming rejections reach the session with CodeGoblin guidance", async () => {
    const model = createOpenAICompatible({
      name: "opencode",
      baseURL: "https://example.test/v1",
      fetch: Object.assign(
        async () =>
          new Response(`data: ${body}\n\ndata: [DONE]\n\n`, {
            headers: { "content-type": "text/event-stream" },
          }),
        { preconnect: fetch.preconnect },
      ),
    }).chatModel("zen-test")
    const result = await model.doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
    })
    const errors: unknown[] = []
    const reader = result.stream.getReader()
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      if (chunk.value.type === "error") errors.push(chunk.value.error)
    }
    expect(errors).toHaveLength(1)
    const error = errors[0]
    if (typeof error !== "string") throw new Error("Expected the SDK to expose the provider message string")
    const parsed = MessageV2.fromError(error, { providerID: ProviderID.make("opencode") })
    expect(parsed.name).toBe("APIError")
    if (parsed.name !== "APIError") throw new Error("Expected a session APIError")
    expect(parsed.data.message).toContain("CodeGoblin")
    expect(parsed.data.isRetryable).toBe(false)
    expect(parsed.data.responseBody).toBe(error)
    expect(MessageV2.fromError(error, { providerID: ProviderID.make("openai") }).name).toBe("UnknownError")
  })

  test("plain version rejections are rewritten only for Zen", () => {
    const text = "Error from provider (Console): OpenCode 1.18.0 or newer is required to use the free tier"
    expect(ProviderError.parseStreamError(text, ProviderID.make("opencode"))?.message).toContain("Update CodeGoblin")
    expect(ProviderError.parseStreamError(text, ProviderID.make("openai"))).toBeUndefined()
    expect(ProviderError.parseStreamError(text)).toBeUndefined()
  })

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
    const result = ProviderError.parseStreamError({
      type: "error",
      error: { code: "invalid_prompt", message: "Please update OpenCode" },
    })
    expect(result?.message).toBe("Please update OpenCode")
  })
})
