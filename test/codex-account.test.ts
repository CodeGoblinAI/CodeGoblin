import { expect, test } from "bun:test"
import path from "node:path"
import fs from "node:fs/promises"
import { CodexRpc } from "../src/core/codex-rpc"
import { quotaWindows, accountRows, codexAccount, cachedCodexAccount, startCodexLogin } from "../src/core/codex-account"
import { importTranscript, listCodexSessions, importCodexSession } from "../src/core/codex-import"
import { codexLoginUrl } from "../src/core/open-browser"
import { Global } from "../src/platform/paths"
import * as sessions from "../src/core/sessions"
import { requireSandbox } from "./sandbox"
import { runCommand } from "../src/core/commands"

const fixture = [process.execPath, path.join(import.meta.dir, "fixtures", "codex-app-server.ts")]
const root = path.resolve(".")
requireSandbox(path.join(Global.Path.state, "codex-account.json"), "codex-account.test.ts")
requireSandbox(path.join(Global.Path.state, "sessions", "import.json"), "codex-account.test.ts")

test("account snapshots and disk caches exclude private CLI account fields", async () => {
  const snapshot = await codexAccount(() => CodexRpc.start(fixture))
  expect(snapshot.state).toBe("ready")
  expect(snapshot.windows[0]?.used).toBe(25)
  const cached = await cachedCodexAccount()
  expect(cached?.windows).toEqual(snapshot.windows)
  const raw = await fs.readFile(path.join(Global.Path.state, "codex-account.json"), "utf8")
  expect(raw).not.toContain("private@example.com")
  expect(raw).not.toContain("planType")
})

test("signed-out, API-key quota-unavailable and read failures are not zero usage", async () => {
  const signedOut = await codexAccount(() => CodexRpc.start([...fixture, "signed-out"]))
  expect(signedOut.state).toBe("signed-out")
  const apiKey = await codexAccount(() => CodexRpc.start([...fixture, "api-key"]))
  expect(apiKey.auth).toBe("apiKey")
  expect(apiKey.windows).toEqual([])
  expect(apiKey.detail).toContain("unavailable")
  const failed = await codexAccount(() => CodexRpc.start([...fixture, "quota-error"]))
  expect(failed.state).toBe("unavailable")
  expect(failed.windows).toEqual([])
  expect(failed.detail).not.toContain("secret")
})

test("sign-in handles early completion, owned cancellation and untrusted URLs", async () => {
  const complete = await startCodexLogin(() => CodexRpc.start([...fixture, "early-login"]))
  expect(complete.status()).toBe("complete")
  await complete.cancel()
  expect(complete.status()).toBe("complete")
  const pending = await startCodexLogin(() => CodexRpc.start(fixture))
  expect(pending.status()).toBe("pending")
  expect(pending.url).toStartWith("https://auth.openai.com/")
  await pending.cancel()
  expect(pending.status()).toBe("cancelled")
  const rpc = await CodexRpc.start(fixture)
  const stopped = await startCodexLogin(async () => rpc)
  await rpc.close()
  expect(stopped.status()).toBe("failed")
  await stopped.cancel()
  const rejected = await startCodexLogin(() => CodexRpc.start([...fixture, "bad-login"])).catch(String)
  expect(rejected).toContain("Could not start official Codex sign-in")
  expect(rejected).not.toContain("secret-token")
  for (const url of ["http://auth.openai.com/", "https://auth.openai.com.evil.test/", "https://user@auth.openai.com/", "https://auth.openai.com:8443/"]) {
    expect(() => codexLoginUrl(url)).toThrow()
  }
})

test("project-scoped CLI import saves a new resumable copy and rejects mismatched IDs", async () => {
  const start = () => CodexRpc.start(fixture)
  const listed = await listCodexSessions(root, undefined, start)
  expect(listed.sessions).toEqual([{ id: "source-1", title: "Fixture transcript", updatedAt: undefined }])
  expect(listed.next).toBe("fixture-next")
  const current = sessions.create("deepseek")
  current.messages.push({ role: "user", content: "Keep current session" })
  await sessions.save(current)
  const copied = await importCodexSession("source-1", root, "deepseek", start)
  expect(copied.id).not.toBe(current.id)
  expect(copied.messages).toBe(2)
  expect((await sessions.load(copied.id))?.importedFrom?.id).toBe("source-1")
  expect((await sessions.load(current.id))?.messages).toEqual(current.messages)
  const refused = await importCodexSession("wrong-id", root, "deepseek", start).catch(String)
  expect(refused).toContain("different conversation")
})

test("stdio requests correlate responses and redact protocol errors", async () => {
  const rpc = await CodexRpc.start(fixture)
  try {
    expect(await Promise.all([rpc.call("echo", { value: 1 }), rpc.call("echo", { value: 2 })])).toEqual([{ value: 1 }, { value: 2 }])
    const error = await rpc.call("fixture/error", {}, 1000).catch(String)
    expect(error).toContain("Codex rejected request")
    expect(error).not.toContain("secret-token")
  } finally { await rpc.close() }
})

test("malformed initialization and timed-out calls fail closed", async () => {
  await expect(CodexRpc.start([...fixture, "bad-init"])).rejects.toThrow("Codex protocol failed")
  const rpc = await CodexRpc.start(fixture)
  try { await expect(rpc.call("fixture/hang", {}, 40)).rejects.toThrow("timed out") }
  finally { await rpc.close() }
})

test("account client refuses unsolicited native tools rather than executing them", async () => {
  const rpc = await CodexRpc.start(fixture)
  try {
    let refused: unknown
    rpc.onNotification((method, params) => { if (method === "fixture/refused") refused = params })
    const error = await rpc.call("fixture/request", {}, 500).catch(String)
    expect(error).toContain("timed out")
    expect(refused).toEqual({ refused: true })
  } finally { await rpc.close() }
})

test("quota windows prefer all named buckets, preserve unknowns and clamp remaining", () => {
  const windows = quotaWindows({ email: "private@example.com", rateLimits: { primary: { usedPercent: 99 } }, rateLimitsByLimitId: {
    codex: { primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 2000000000 }, secondary: null },
    other: { limitName: "Other\u001b account", primary: { usedPercent: 120 }, secondary: { usedPercent: null, windowDurationMins: null, resetsAt: null } },
  } })
  expect(windows).toHaveLength(3)
  expect(windows[0]?.used).toBe(25)
  expect(windows[2]?.used).toBeUndefined()
  const rows = accountRows({ state: "ready", detail: "fixture", windows, checkedAt: Date.now() - 360000 })
  expect(JSON.stringify(rows)).toContain("0% remaining")
  expect(JSON.stringify(rows)).toContain("usage unavailable")
  expect(JSON.stringify(rows)).toContain("stale snapshot")
  expect(JSON.stringify(rows)).not.toContain("private@example.com")
  expect(JSON.stringify(rows)).not.toContain("\u001b")
})

test("zero usage is real, missing windows stay unavailable", () => {
  expect(quotaWindows({ rateLimits: { primary: { usedPercent: 0 }, secondary: null } })[0]?.used).toBe(0)
  expect(quotaWindows({ rateLimits: {} })).toEqual([])
})

test("imports create independent text copies with provenance and no native capability", () => {
  const input = { thread: { id: "source-1", cwd: root, name: "Example", turns: [{ items: [
    { type: "userMessage", content: [{ type: "text", text: "Hello" }, { type: "image", url: "secret-image" }] },
    { type: "commandExecution", command: "secret-command" }, { type: "reasoning", text: "private-reasoning" },
    { type: "agentMessage", text: "Hi" },
  ] }] } }
  const a = importTranscript(input, root, "deepseek")
  const b = importTranscript(input, root, "deepseek")
  expect(a.id).not.toBe(b.id)
  expect(a.id).not.toBe("source-1")
  expect(a.messages).toEqual([{ role: "user", content: "Hello" }, { role: "assistant", content: "Hi" }])
  expect(a.importedFrom?.id).toBe("source-1")
  expect(a.spend).toBeUndefined()
  expect(JSON.stringify(a)).not.toContain("secret")
  expect(() => importTranscript(input, path.join(root, "different"), "deepseek")).toThrow("does not belong")
  expect(() => importTranscript({ thread: { id: "../bad", cwd: root, turns: input.thread.turns } }, root, "deepseek")).toThrow("Invalid Codex session ID")
})

test("empty or oversized imports are refused", () => {
  expect(() => importTranscript({ thread: { id: "test", cwd: root, turns: [] } }, root, "deepseek")).toThrow("No text messages")
  expect(() => importTranscript({ thread: { id: "test", cwd: root, turns: [{ items: [{ type: "agentMessage", text: "x".repeat(2000001) }] }] } }, root, "deepseek")).toThrow("too large")
})

test("account, login and explicit import commands enforce their supported source", () => {
  expect(runCommand("/account codex")).toEqual({ kind: "account" })
  expect(runCommand("/login codex")).toEqual({ kind: "login" })
  expect(runCommand("/import codex session-1")).toEqual({ kind: "import", id: "session-1" })
  expect(runCommand("/import codex a b").kind).toBe("message")
  expect(runCommand("/import cursor").kind).toBe("message")
})
