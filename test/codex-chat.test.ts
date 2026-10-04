import { expect, test } from "bun:test"
import path from "node:path"
import { codexChat, codexAuthStatus } from "../src/core/codex-chat"
import { CodexRpc } from "../src/core/codex-rpc"
import { apiKey } from "../src/core/auth"
import { resolveSelection, effortFor } from "../src/core/providers"

const fixture = path.resolve(import.meta.dir, "fixtures/codex-app-server.ts")
const start = (mode = "inference", timeout = 3000) => () => CodexRpc.start([process.execPath, fixture, mode], timeout, true)
const collect = async (input: Parameters<typeof codexChat>[0]) => { const events = []; for await (const event of codexChat(input)) events.push(event); return events }

test("Codex uses official CLI auth and an unpriced, unknown-window model entry", () => {
  expect(apiKey("codex")).toBe("")
  expect(resolveSelection("codex/default")?.provider.cli).toBe("codex")
  expect(resolveSelection("codex/default")?.model.contextWindow).toBe(0)
  expect(resolveSelection("codex/default")?.model.price).toBeUndefined()
})

test("ephemeral Codex inference disables environment/native capabilities, scopes early notifications and counts total once", async () => {
  const events = await collect({ modelId: "default", prompt: "Fixture prompt", system: "Fixture instructions", start: start() })
  expect(events).toEqual([{ type: "text", delta: "CODEX_FIXTURE" }, { type: "spend", input: 15, output: 5 }])
  expect(await collect({ modelId: "default", prompt: "Fixture", system: "Fixture", start: start("fallback-inference") })).toEqual(events)
  expect(await collect({ modelId: "default", prompt: "Fixture", system: "Fixture", effort: effortFor(resolveSelection("codex/default")!.model, "high"), start: start("effort-inference") })).toEqual(events)
})

test("official model catalog exposes effort only where reported, including the default alias", async () => {
  expect((await codexAuthStatus(start())).ready).toBe(true)
  expect(effortFor(resolveSelection("codex/default")!.model, "high")).toBe("high")
  expect(effortFor(resolveSelection("codex/fixture-no-effort")!.model, "high")).toBeUndefined()
})

test("old protocol, unsafe sandbox, native tool and failed turn never become success", async () => {
  for (const mode of ["old-version", "unsafe-policy", "native-inference", "failed-inference", "signed-out"]) {
    const failure = await collect({ modelId: "default", prompt: "Fixture", system: "Fixture", start: start(mode) }).catch((error) => error as Error)
    expect(failure).toBeInstanceOf(Error)
    expect(String(failure)).not.toContain("secret-token")
  }
})

test("owned process lifetime and cancellation unblock an unfinished inference stream", async () => {
  await expect(collect({ modelId: "default", prompt: "Fixture", system: "Fixture", start: start("hang-inference", 500) })).rejects.toThrow("before completion")
  const controller = new AbortController()
  const stream = codexChat({ modelId: "default", prompt: "Fixture", system: "Fixture", start: start("hang-inference"), signal: controller.signal })
  expect((await stream.next()).value?.type).toBe("text")
  controller.abort()
  await expect(stream.next()).rejects.toThrow()
  await expect(collect({ modelId: "default", prompt: "Fixture", system: "Fixture", start: start(), signal: AbortSignal.abort() })).rejects.toThrow()
})
