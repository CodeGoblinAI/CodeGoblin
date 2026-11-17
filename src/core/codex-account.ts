import fs from "node:fs/promises"
import { replaceFile } from "../platform/replace-file"
import path from "node:path"
import { Global } from "../platform/paths"
import { CodexRpc, object } from "./codex-rpc"
import { codexLoginUrl } from "./open-browser"

export type CodexAccount = {
  state: "ready" | "signed-out" | "unavailable"
  detail: string
  checkedAt: number
  auth?: "chatgpt" | "apiKey"
  windows: { label: string; used?: number; minutes?: number; resetsAt?: number }[]
}

const cache = path.join(Global.Path.state, "codex-account.json")
const text = (value: unknown, fallback: string) => typeof value === "string" && value ? value.replace(/[\x00-\x1f\x7f]/g, "").slice(0, 80) : fallback
const finite = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined

/** Keep only displayable quota fields. Never retain email, account ID, tokens or login URLs. */
export function quotaWindows(input: unknown): CodexAccount["windows"] {
  const raw = object(input)
  const grouped = object(raw.rateLimitsByLimitId)
  const buckets = Object.keys(grouped).length ? Object.entries(grouped) : [["codex", raw.rateLimits]]
  return buckets.slice(0, 12).flatMap(([id, value]) => {
    const bucket = object(value)
    return ["primary", "secondary"].flatMap((slot) => {
      if (!bucket[slot]) return []
      const window = object(bucket[slot])
      return [{ label: text(bucket.limitName, text(id, "Codex")) + " " + slot,
        used: finite(window.usedPercent), minutes: finite(window.windowDurationMins), resetsAt: finite(window.resetsAt) }]
    })
  })
}

export async function codexAccount(start = () => CodexRpc.start()): Promise<CodexAccount> {
  let rpc: CodexRpc | undefined
  try {
    rpc = await start()
    const response = object(await rpc.call("account/read", { refreshToken: false }))
    const account = object(response.account)
    if (account.type !== "chatgpt" && account.type !== "apiKey") {
      return { state: "signed-out", detail: "Run /login codex or codex login; no supported official sign-in is available", checkedAt: Date.now(), windows: [] }
    }
    const windows = account.type === "chatgpt" ? quotaWindows(await rpc.call("account/rateLimits/read")) : []
    const snapshot: CodexAccount = { state: "ready", auth: account.type, checkedAt: Date.now(), windows,
      detail: account.type === "apiKey" ? "Official CLI API-key mode; subscription quotas unavailable" : windows.length ? "Official CLI snapshot; shared ChatGPT account" : "Signed in; quota windows unavailable (not zero)" }
    // A read-only profile must still be able to show a valid live snapshot.
    await (async () => {
      await fs.mkdir(path.dirname(cache), { recursive: true })
      const temporary = cache + "." + crypto.randomUUID() + ".tmp"
      await fs.writeFile(temporary, JSON.stringify(snapshot), { mode: 0o600 })
      await replaceFile(temporary, cache)
    })().catch(() => {})
    return snapshot
  } catch {
    return { state: "unavailable", detail: "Could not read Codex account/quotas; check codex login status and CLI compatibility", checkedAt: Date.now(), windows: [] }
  } finally { await rpc?.close() }
}

export async function cachedCodexAccount(): Promise<CodexAccount | undefined> {
  try {
    const raw = object(JSON.parse(await fs.readFile(cache, "utf8")))
    if (raw.state !== "ready" || typeof raw.checkedAt !== "number" || !Array.isArray(raw.windows)) return
    return { state: "ready", checkedAt: raw.checkedAt, auth: raw.auth === "apiKey" ? "apiKey" : "chatgpt",
      detail: "Cached official CLI snapshot; refresh to check current usage", windows: raw.windows.slice(0, 24).map((value) => {
        const window = object(value)
        return { label: text(window.label, "Codex"), used: finite(window.used), minutes: finite(window.minutes), resetsAt: finite(window.resetsAt) }
      }) }
  } catch { return }
}

export function accountRows(snapshot: CodexAccount): [string, string][] {
  return [
    ["Codex account", snapshot.state], ["status", snapshot.detail],
    ...snapshot.windows.flatMap((window): [string, string][] => [
      [window.label, window.used === undefined ? "usage unavailable" : window.used + "% used / " + Math.max(0, 100 - window.used) + "% remaining"],
      ["window / reset", (window.minutes === undefined ? "unknown window" : window.minutes + " min") + " / " + (window.resetsAt === undefined ? "unknown" : new Date(window.resetsAt * 1000).toLocaleString())],
    ]),
    ["checked", new Date(snapshot.checkedAt).toLocaleString()],
    ["freshness", Date.now() - snapshot.checkedAt > 5 * 60_000 ? "stale snapshot; refresh" : "snapshot; not continuously monitored"],
  ]
}

export async function startCodexLogin(start = () => CodexRpc.start(undefined, 5 * 60_000)) {
  const rpc = await start()
  const expiresAt = Date.now() + 5 * 60_000
  let state: "pending" | "complete" | "failed" | "cancelled" = "pending"
  let completion: Record<string, unknown> | undefined
  let loginId: string | undefined
  const applyCompletion = () => {
    if (state !== "pending" || !loginId || completion?.loginId !== loginId) return
    state = completion.success === true ? "complete" : "failed"
    void rpc.close()
  }
  rpc.onNotification((method, params) => {
    if (method !== "account/login/completed") return
    completion = object(params)
    applyCompletion()
  })
  try {
    const result = object(await rpc.call("account/login/start", { type: "chatgpt" }))
    if (result.type !== "chatgpt" || typeof result.loginId !== "string" || typeof result.authUrl !== "string") throw new Error("Unsupported Codex login response")
    const url = codexLoginUrl(result.authUrl)
    loginId = result.loginId
    applyCompletion()
    const cancel = async () => {
      if (state === "pending") {
        state = "cancelled"
        await rpc.call("account/login/cancel", { loginId: result.loginId }, 3000).catch(() => {})
      }
      await rpc.close()
    }
    return { url, cancel, expiresAt, status: () => state !== "pending" ? state : Date.now() >= expiresAt ? "expired" : rpc.closed ? "failed" : "pending" }
  } catch { await rpc.close(); throw new Error("Could not start official Codex sign-in; run codex login") }
}
