import { describe, expect, test } from "bun:test"
import { codeGoblinProviderInfo, hasCodeGoblinGateway } from "../../src/codegoblin/provider"

describe("CodeGoblin hosted gateway gating", () => {
  test("is off when no gateway env var is set", () => {
    // The default baseURL is a loopback port nothing listens on, so listing the
    // hosted models made them selectable and every turn hung with no error.
    expect(hasCodeGoblinGateway({} as NodeJS.ProcessEnv)).toBe(false)
  })

  test("is enabled by any of the gateway env vars", () => {
    expect(hasCodeGoblinGateway({ CODEGOBLIN_API_KEY: "x" } as NodeJS.ProcessEnv)).toBe(true)
    expect(hasCodeGoblinGateway({ CODEGOBLIN_GATEWAY_KEY: "x" } as NodeJS.ProcessEnv)).toBe(true)
    expect(hasCodeGoblinGateway({ CODEGOBLIN_GATEWAY_URL: "http://x" } as NodeJS.ProcessEnv)).toBe(true)
  })

  test("registers the provider even with the models gated", () => {
    // Locally-served GGUF models from `codegoblin runtime` attach to this same
    // provider id, so the provider entry must survive the gating.
    const info = codeGoblinProviderInfo({} as NodeJS.ProcessEnv)
    expect(String(info.id)).toBe("codegoblin")
    expect(Object.keys(info.models)).toEqual([])
  })

  test("lists the hosted models once a gateway is configured", () => {
    const info = codeGoblinProviderInfo({ CODEGOBLIN_GATEWAY_KEY: "x" } as NodeJS.ProcessEnv)
    expect(Object.keys(info.models)).toContain("goblin-mock")
    expect(Object.keys(info.models)).toContain("deepseek-chat")
  })
})
