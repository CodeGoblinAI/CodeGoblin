import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import * as auth from "../src/core/auth"
import * as connected from "../src/domain/connected-auth"
import { requireSandbox } from "./sandbox"

// These tests connect keys, corrupt the store on purpose and repair it. This
// file used to point the store at a scratch home of its own, which quietly
// stopped working once another test had imported the paths first - and on
// 2026-09-12 that is how a run wiped the real key store. test/preload.ts now
// sandboxes the whole run before any file loads, and nothing below writes a
// key unless the store is inside that sandbox.
const home = requireSandbox(auth.storePath(), "the auth tests")
await fs.mkdir(path.dirname(auth.storePath()), { recursive: true })

const FAKE = "sk-fake-not-a-real-key-0000"

test("Cursor explicit API key has one documented env name and never authenticates the browser route", async () => {
  const previous = process.env.CURSOR_API_KEY
  await auth.connect("cursor-api", FAKE)
  process.env.CURSOR_API_KEY = "cursor-env-fixture"
  try {
    expect(auth.apiKey("cursor-api")).toBe("cursor-env-fixture")
    expect(auth.apiKey("cursor")).toBe("")
    expect(auth.connections().some((entry) => entry.id === "cursor-api")).toBe(true)
    expect(auth.envVariable("cursor-api")).toBe("CURSOR_API_KEY")
  } finally {
    if (previous === undefined) delete process.env.CURSOR_API_KEY
    if (previous !== undefined) process.env.CURSOR_API_KEY = previous
    await auth.disconnect("cursor-api")
  }
})

describe("keeping keys", () => {
  test("stores one and reads it back", async () => {
    await auth.connect("testprovider", FAKE)
    expect(auth.apiKey("testprovider")).toBe(FAKE)
    expect(auth.isConnected("testprovider")).toBe(true)
  })

  test("writes into the scratch home, nowhere near the real store", () => {
    expect(auth.storePath().startsWith(home)).toBe(true)
  })

  test("trims, and refuses nothing at all", async () => {
    await auth.connect("spaced", "  " + FAKE + "  ")
    expect(auth.apiKey("spaced")).toBe(FAKE)
    await expect(auth.connect("empty", "   ")).rejects.toThrow("no key given")
  })

  test("adding one key leaves the others alone", async () => {
    await auth.connect("first", "aaaa1111")
    await auth.connect("second", "bbbb2222")
    expect([auth.apiKey("first"), auth.apiKey("second")]).toEqual(["aaaa1111", "bbbb2222"])
  })

  test("forgetting one leaves the others alone", async () => {
    await auth.connect("keepme", "cccc3333")
    await auth.connect("dropme", "dddd4444")
    expect(await auth.disconnect("dropme")).toBe(true)
    expect(auth.apiKey("dropme")).toBeUndefined()
    expect(auth.apiKey("keepme")).toBe("cccc3333")
  })

  test("forgetting something that was never there is false, not an error", async () => {
    expect(await auth.disconnect("neverexisted")).toBe(false)
  })
})

describe("what gets shown", () => {
  test("a hint is the last four characters and nothing else", () => {
    expect(auth.maskKey("sk-abcdefghijklmnop")).toBe("····mnop")
    expect(auth.maskKey("sk-abcdefghijklmnop")).not.toContain("abcdef")
  })

  test("a very short key gives away nothing at all", () => {
    expect(auth.maskKey("abc")).toBe("····")
    expect(auth.maskKey("")).toBe("····")
  })

  test("listing never carries a whole key", async () => {
    await auth.connect("listed", FAKE)
    const listed = auth.connections()
    const entry = listed.find((item) => item.id === "listed")
    expect(entry?.hint).toBe("····0000")
    expect(JSON.stringify(listed)).not.toContain(FAKE)
  })
})

describe("the environment", () => {
  test("wins over the stored key, so one run can use a different one", async () => {
    await auth.connect("envtest", "stored-key")
    process.env.ENVTEST_API_KEY = "environment-key"
    expect(auth.apiKey("envtest")).toBe("environment-key")
    delete process.env.ENVTEST_API_KEY
    expect(auth.apiKey("envtest")).toBe("stored-key")
  })

  test("shows up in the listing, so a provider that works without being connected explains itself", () => {
    process.env.ONLYENV_API_KEY = "from-the-environment"
    const entry = auth.connections().find((item) => item.id === "onlyenv")
    expect(entry?.source).toBe("environment")
    // The value is never read into the listing, only the fact that it exists.
    expect(JSON.stringify(entry)).not.toContain("from-the-environment")
    delete process.env.ONLYENV_API_KEY
  })

  test("names the variable that would supply a key without storing it", () => {
    expect(auth.envVariable("tripo")).toBe("TRIPO_API_KEY")
    expect(auth.envVariable("claude-code")).toBe("CLAUDE_CODE_API_KEY")
  })
})

describe("a store that has been damaged", () => {
  test("unreadable json means no keys rather than no app", async () => {
    await fs.writeFile(auth.storePath(), "{ not json", "utf8")
    expect(auth.apiKey("anything")).toBeUndefined()
    expect(auth.connections().filter((item) => item.source === "file")).toEqual([])
  })

  test("and writing again repairs it instead of failing forever", async () => {
    await auth.connect("recovered", "eeee5555")
    expect(auth.apiKey("recovered")).toBe("eeee5555")
  })
})

/**
 * The generators resolve keys through connected-auth, which used to parse
 * auth.json on its own. That made TRIPO_API_KEY work for a conversation and
 * not for a generation - the same key, two answers, no way to tell why.
 */
describe("the generators resolve keys the same way everything else does", () => {
  test("a stored key reaches the generators", async () => {
    await auth.connect("tripo", "tripo-stored-key")
    expect(await connected.readConnectedProviderKey("tripo")).toBe("tripo-stored-key")
  })

  test("an environment key reaches them too, which it did not before", async () => {
    process.env.ALIBABA_API_KEY = "from-the-environment"
    try {
      expect(await connected.readConnectedProviderKey("alibaba")).toBe("from-the-environment")
    } finally {
      delete process.env.ALIBABA_API_KEY
    }
  })

  test("the environment still wins over the file, in both paths", async () => {
    await auth.connect("google", "google-stored")
    process.env.GOOGLE_API_KEY = "google-from-env"
    try {
      expect(auth.apiKey("google")).toBe("google-from-env")
      expect(await connected.readConnectedProviderKey("google")).toBe("google-from-env")
    } finally {
      delete process.env.GOOGLE_API_KEY
    }
  })

  test("a provider nobody connected has no key rather than an empty string", async () => {
    expect(await connected.readConnectedProviderKey("nobody")).toBeUndefined()
  })
})
