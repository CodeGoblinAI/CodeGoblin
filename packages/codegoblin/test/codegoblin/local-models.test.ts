import { describe, expect, test } from "bun:test"
import {
  discoverLocalModels,
  formatLocalModels,
  lmStudioBaseURL,
  ollamaBaseURL,
  type LocalModelRuntime,
} from "@/codegoblin/local-models"

type RouteConfig = { ok?: boolean; json?: unknown; throw?: boolean }

function fakeFetch(routes: Record<string, RouteConfig>) {
  return (async (url: string | URL) => {
    const href = typeof url === "string" ? url : url.toString()
    for (const [needle, cfg] of Object.entries(routes)) {
      if (href.includes(needle)) {
        if (cfg.throw) throw new Error("ECONNREFUSED")
        return { ok: cfg.ok ?? true, json: async () => cfg.json } as Response
      }
    }
    throw new Error("ECONNREFUSED")
  }) as typeof fetch
}

describe("base URL resolution", () => {
  test("ollama prefers CODEGOBLIN_OLLAMA_URL, then OLLAMA_HOST, then default", () => {
    expect(ollamaBaseURL({})).toBe("http://127.0.0.1:11434")
    expect(ollamaBaseURL({ OLLAMA_HOST: "10.0.0.5:11434" })).toBe("http://10.0.0.5:11434")
    expect(ollamaBaseURL({ CODEGOBLIN_OLLAMA_URL: "http://gpu.local:11434/" })).toBe("http://gpu.local:11434")
  })

  test("lm studio default and override", () => {
    expect(lmStudioBaseURL({})).toBe("http://127.0.0.1:1234")
    expect(lmStudioBaseURL({ CODEGOBLIN_LMSTUDIO_URL: "127.0.0.1:5000" })).toBe("http://127.0.0.1:5000")
  })
})

describe("discoverLocalModels", () => {
  test("detects Ollama models and marks LM Studio offline", async () => {
    const fetchFn = fakeFetch({
      "/api/tags": { json: { models: [{ name: "gemma2:2b" }, { name: "llama3.2" }] } },
      "/v1/models": { throw: true },
    })
    const result = await discoverLocalModels({ fetchFn, env: {} })
    const ollama = result.find((r) => r.id === "ollama")!
    const lmstudio = result.find((r) => r.id === "lmstudio")!
    expect(ollama.available).toBe(true)
    expect(ollama.models).toEqual(["gemma2:2b", "llama3.2"])
    expect(lmstudio.available).toBe(false)
    expect(lmstudio.models).toEqual([])
  })

  test("detects LM Studio via OpenAI-compatible /v1/models", async () => {
    const fetchFn = fakeFetch({
      "/api/tags": { throw: true },
      "/v1/models": { json: { data: [{ id: "qwen2.5-coder-1.5b" }] } },
    })
    const result = await discoverLocalModels({ fetchFn, env: {} })
    expect(result.find((r) => r.id === "lmstudio")!.models).toEqual(["qwen2.5-coder-1.5b"])
  })

  test("marks runtimes offline when nothing is listening", async () => {
    const result = await discoverLocalModels({ fetchFn: fakeFetch({}), env: {} })
    expect(result.every((r) => !r.available)).toBe(true)
  })

  test("treats a non-OK HTTP response as offline", async () => {
    const fetchFn = fakeFetch({ "/api/tags": { ok: false, json: {} }, "/v1/models": { ok: false, json: {} } })
    const result = await discoverLocalModels({ fetchFn, env: {} })
    expect(result.every((r) => !r.available)).toBe(true)
  })
})

describe("formatLocalModels", () => {
  const runtime = (over: Partial<LocalModelRuntime>): LocalModelRuntime => ({
    id: "ollama",
    name: "Ollama",
    baseURL: "http://127.0.0.1:11434",
    available: false,
    models: [],
    ...over,
  })

  test("reports none detected when all offline", () => {
    expect(formatLocalModels([runtime({}), runtime({ id: "lmstudio" })])).toMatch(/none detected/i)
  })

  test("previews up to three models and counts the rest", () => {
    const line = formatLocalModels([runtime({ available: true, models: ["a", "b", "c", "d", "e"] })])
    expect(line).toContain("a, b, c, +2 more")
    expect(line).toContain("http://127.0.0.1:11434")
  })

  test("notes a running runtime with no models pulled", () => {
    expect(formatLocalModels([runtime({ available: true, models: [] })])).toMatch(/no models pulled/i)
  })
})
