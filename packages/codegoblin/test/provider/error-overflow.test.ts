import { describe, expect, test } from "bun:test"
import { ProviderError } from "@/provider/error"
import { ProviderID } from "@/provider/schema"

const LLAMA_RAW = "request (4539 tokens) exceeds the available context size (2048 tokens), try increasing it"

describe("contextOverflowMessage", () => {
  test("rewrites llama.cpp overflow into an actionable local-model message", () => {
    const out = ProviderError.contextOverflowMessage(ProviderID.make("codegoblin"), LLAMA_RAW)
    expect(out).toContain("4539 tokens")
    expect(out).toContain("2048-token context")
    expect(out).toContain("--ctx")
    expect(out).not.toContain("try increasing it")
  })

  test("falls back to a generic local message when the pattern doesn't match", () => {
    const out = ProviderError.contextOverflowMessage(ProviderID.make("codegoblin"), "some other overflow text")
    expect(out).toMatch(/context window was exceeded/i)
  })

  test("leaves non-codegoblin providers' messages untouched", () => {
    expect(ProviderError.contextOverflowMessage(ProviderID.make("openai"), LLAMA_RAW)).toBe(LLAMA_RAW)
  })
})
