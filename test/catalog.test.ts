import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { Global } from "../src/platform/paths"
import { asProvider, catalogEnv, loadCatalog, rememberCatalogEnv, usableCatalog } from "../src/core/catalog"
import { CONNECTABLE, PROVIDERS, activateCatalog, refreshCatalog } from "../src/core/providers"
import { apiKey, envVariable } from "../src/core/auth"

const SAMPLE = {
  "acme-ai": {
    id: "acme-ai", name: "Acme AI", env: ["ACME_KEY"], npm: "@ai-sdk/openai-compatible", api: "https://api.acme.example/v1",
    models: {
      "acme-large": { id: "acme-large", name: "Acme Large", tool_call: true, reasoning: true, limit: { context: 200000 }, cost: { input: 1, output: 4 }, modalities: { input: ["text", "image"], output: ["text"] } },
      "acme-chat": { id: "acme-chat", name: "Acme Chat (no tools)", tool_call: false, modalities: { input: ["text"], output: ["text"] } },
      "acme-old": { id: "acme-old", name: "Old", tool_call: true, status: "deprecated" },
      "acme-draw": { id: "acme-draw", name: "Draw", tool_call: true, modalities: { input: ["text"], output: ["image"] } },
    },
  },
  groq: { id: "groq", name: "Groq", env: ["GROQ_API_KEY"], npm: "@ai-sdk/groq", models: { "llama-x": { id: "llama-x", name: "Llama X", tool_call: true } } },
  "weird-sdk": { id: "weird-sdk", name: "Weird", npm: "some-custom-sdk", models: { m: { id: "m", tool_call: true } } },
  "bad id!": { id: "bad id!", npm: "@ai-sdk/openai-compatible", api: "https://x.example", models: { m: { id: "m", tool_call: true } } },
}

describe("models.dev catalog", () => {
  test("keeps providers CG-Next can call and models an agent can use", () => {
    const usable = usableCatalog(SAMPLE)
    expect(usable.map((p) => p.id)).toEqual(["acme-ai", "groq"])
    const acme = usable[0]!
    expect(acme.baseUrl).toBe("https://api.acme.example/v1")
    expect(acme.models.map((m) => m.id)).toEqual(["acme-large"])
    expect(acme.models[0]).toMatchObject({ label: "Acme Large", contextWindow: 200000, reasoning: true, price: { input: 1, output: 4 }, capabilities: { input: { text: true, image: true } } })
    expect(usable[1]!.baseUrl).toBe("https://api.groq.com/openai/v1")
    expect(asProvider(acme).baseUrl).toBe("https://api.acme.example/v1/chat/completions")
  })

  test("fetched once a day and cached; a failed fetch keeps the cache", async () => {
    try { fs.rmSync(path.join(Global.Path.cache, "models-dev.json")) } catch {}
    let fetched = 0
    const ok = (async () => { fetched++; return new Response(JSON.stringify(SAMPLE)) }) as unknown as typeof fetch
    const down = (async () => { fetched++; throw new Error("offline") }) as unknown as typeof fetch
    expect((await loadCatalog({ fetch: ok, now: 1000 })).length).toBe(2)
    expect((await loadCatalog({ fetch: ok, now: 1000 + 60_000 })).length).toBe(2)
    expect(fetched).toBe(1)
    expect((await loadCatalog({ fetch: down, now: 1000 + 2 * 86_400_000 })).length).toBe(2)
    expect(fetched).toBe(2)
  })

  test("a provider joins the picker once it has a key, and /connect lists it before then", async () => {
    await refreshCatalog(() => undefined, async () => usableCatalog(SAMPLE))
    expect(PROVIDERS["acme-ai"]).toBeUndefined()
    expect(CONNECTABLE.some((entry) => entry.id === "acme-ai")).toBe(true)
    expect(activateCatalog((id) => (id === "acme-ai" ? "key" : undefined))).toEqual(["acme-ai"])
    expect(PROVIDERS["acme-ai"]?.models[0]?.id).toBe("acme-large")
    // Built-ins are never replaced by a catalog entry of the same id.
    expect(activateCatalog(() => "key")).not.toContain("deepseek")
  })

  test("the key can come from the variable models.dev names", () => {
    rememberCatalogEnv(usableCatalog(SAMPLE))
    expect(catalogEnv("acme-ai")).toEqual(["ACME_KEY"])
    expect(envVariable("acme-ai")).toBe("ACME_KEY")
    process.env.ACME_KEY = "from-env"
    expect(apiKey("acme-ai")).toBe("from-env")
    delete process.env.ACME_KEY
  })
})

describe("where a connected key is sent", () => {
  const entry = (id: string, baseUrl: string) => ({ id, label: id, env: [], baseUrl, models: [] })

  test("the address a key was first used with is kept when the catalog later names another host", async () => {
    const { acceptAddress, addressNotices } = await import("../src/core/catalog")
    acceptAddress("pinme")
    expect(asProvider(entry("pinme", "https://api.real.example/v1")).baseUrl).toBe("https://api.real.example/v1/chat/completions")
    // Same host, another path: an ordinary change, followed.
    expect(asProvider(entry("pinme", "https://api.real.example/v2")).baseUrl).toBe("https://api.real.example/v2/chat/completions")
    expect(addressNotices()).toEqual([])
    // Another host: the key keeps going where it went, and it is said.
    expect(asProvider(entry("pinme", "https://collect.attacker.example/v1")).baseUrl).toBe("https://api.real.example/v2/chat/completions")
    expect(addressNotices().join(" ")).toContain("pinme: the model catalog now lists this provider at collect.attacker.example")
    expect(addressNotices().join(" ")).toContain("/connect pinme again")
    // A look-alike host is another host.
    expect(asProvider(entry("pinme", "https://api.real.example.attacker.example/v1")).baseUrl).toBe("https://api.real.example/v2/chat/completions")
    // The catalog going back to the right host clears the notice.
    expect(asProvider(entry("pinme", "https://api.real.example/v2")).baseUrl).toBe("https://api.real.example/v2/chat/completions")
    expect(addressNotices()).toEqual([])
    // Connecting again is the person accepting the move.
    asProvider(entry("pinme", "https://new.example/v1"))
    acceptAddress("pinme")
    expect(asProvider(entry("pinme", "https://new.example/v1")).baseUrl).toBe("https://new.example/v1/chat/completions")
    expect(addressNotices()).toEqual([])
    acceptAddress("pinme")
  })
})
