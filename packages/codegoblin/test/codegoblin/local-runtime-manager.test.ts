import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { modelIdFromServed, planRuntimeAction } from "@/codegoblin/local-runtime-manager"
import { readRuntimeState, writeRuntimeState } from "@/codegoblin/local-runtime"
import { adoptLegacyDir } from "@codegoblin/core/global"

describe("planRuntimeAction", () => {
  test("server down -> start", () => {
    expect(planRuntimeAction({ healthy: false, requested: "qwen3-0.6b" })).toBe("start")
  })

  test("healthy and serving the requested model -> none", () => {
    expect(planRuntimeAction({ healthy: true, served: "qwen3-0.6b", requested: "qwen3-0.6b", pid: 123 })).toBe("none")
  })

  test("healthy but serving a different model with tracked pid -> restart (auto-swap)", () => {
    expect(planRuntimeAction({ healthy: true, served: "gemma-3n-e2b", requested: "qwen3-0.6b", pid: 123 })).toBe(
      "restart",
    )
  })

  test("healthy, different model, no tracked pid -> conflict (never kill a stranger)", () => {
    expect(planRuntimeAction({ healthy: true, served: "gemma-3n-e2b", requested: "qwen3-0.6b" })).toBe("conflict")
  })

  test("healthy but served model unknown and no pid -> conflict (do not assume)", () => {
    expect(planRuntimeAction({ healthy: true, served: undefined, requested: "qwen3-0.6b" })).toBe("conflict")
  })
})

describe("modelIdFromServed", () => {
  test("strips windows path and .gguf extension", () => {
    expect(modelIdFromServed("C:\\Users\\x\\runtime\\models\\qwen3-0.6b.gguf")).toBe("qwen3-0.6b")
  })
  test("strips posix path", () => {
    expect(modelIdFromServed("/home/x/runtime/models/gemma-3n-e2b.gguf")).toBe("gemma-3n-e2b")
  })
  test("plain alias passes through", () => {
    expect(modelIdFromServed("qwen3-0.6b")).toBe("qwen3-0.6b")
  })
})

describe("runtime state pid round-trip", () => {
  test("pid persists and parses", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cg-rt-state-"))
    const env = { CODEGOBLIN_RUNTIME_DIR: dir }
    try {
      await writeRuntimeState({ model: "qwen3-0.6b", port: 8787, ctx: 32768, pid: 4242 }, env)
      const state = await readRuntimeState(env)
      expect(state).toEqual({ model: "qwen3-0.6b", port: 8787, ctx: 32768, pid: 4242 })
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})

describe("adoptLegacyDir (opencode -> codegoblin data dir migration)", () => {
  test("renames legacy dir into place when new one is missing", async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), "cg-migrate-"))
    const legacy = path.join(base, "opencode")
    const next = path.join(base, "codegoblin")
    await fs.mkdir(path.join(legacy, "runtime", "models"), { recursive: true })
    await fs.writeFile(path.join(legacy, "auth.json"), "{}")
    try {
      expect(adoptLegacyDir(next, legacy)).toBe(next)
      expect(await fs.readFile(path.join(next, "auth.json"), "utf8")).toBe("{}")
      expect(await fs.stat(legacy).catch(() => undefined)).toBeUndefined()
    } finally {
      await fs.rm(base, { recursive: true, force: true })
    }
  })

  test("keeps existing new dir untouched (no double migration)", async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), "cg-migrate-"))
    const legacy = path.join(base, "opencode")
    const next = path.join(base, "codegoblin")
    await fs.mkdir(legacy, { recursive: true })
    await fs.writeFile(path.join(legacy, "auth.json"), "old")
    await fs.mkdir(next, { recursive: true })
    await fs.writeFile(path.join(next, "auth.json"), "new")
    try {
      expect(adoptLegacyDir(next, legacy)).toBe(next)
      expect(await fs.readFile(path.join(next, "auth.json"), "utf8")).toBe("new")
      expect(await fs.readFile(path.join(legacy, "auth.json"), "utf8")).toBe("old")
    } finally {
      await fs.rm(base, { recursive: true, force: true })
    }
  })

  test("no legacy dir -> just returns the new path", async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), "cg-migrate-"))
    const next = path.join(base, "codegoblin")
    try {
      expect(adoptLegacyDir(next, path.join(base, "opencode"))).toBe(next)
    } finally {
      await fs.rm(base, { recursive: true, force: true })
    }
  })
})
