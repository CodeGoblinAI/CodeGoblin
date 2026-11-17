import fs from "node:fs/promises"
import { replaceFile } from "../platform/replace-file"
import path from "node:path"
import { claudeExecutable } from "./claude-cli"
import { Global } from "../platform/paths"
import { accountRows, type CodexAccount } from "./codex-account"

export type SubscriptionSource = "claude" | "cursor"
export type SubscriptionAccount = CodexAccount & { source: SubscriptionSource }
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
const finite = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined
const cache = (source: SubscriptionSource) => path.join(Global.Path.state, source + "-account.json")

export function parseClaudeAccount(value: unknown, checkedAt = Date.now()): SubscriptionAccount {
  const raw = object(value)
  const limits = object(raw.rate_limits)
  const windows = [
    ["five_hour", "Claude 5h", 300], ["seven_day", "Claude week", 10080],
    ["seven_day_oauth_apps", "Claude OAuth apps", 10080], ["seven_day_opus", "Claude Opus", 10080], ["seven_day_sonnet", "Claude Sonnet", 10080],
  ].flatMap(([key, label, minutes]) => {
    const entry = object(limits[String(key)])
    if (!Object.keys(entry).length) return []
    const date = typeof entry.resets_at === "string" ? Date.parse(entry.resets_at) : NaN
    return [{ label: String(label), used: finite(entry.utilization), minutes: Number(minutes), resetsAt: Number.isFinite(date) && date >= 0 ? date / 1000 : undefined }]
  })
  return { source: "claude", state: raw.rate_limits_available === true ? "ready" : "unavailable", checkedAt, windows: raw.rate_limits_available === true ? windows : [],
    detail: raw.rate_limits_available === true ? windows.length ? "Official Claude CLI plan snapshot; no inference performed" : "Signed in; quota windows unavailable (not zero)" : "Claude plan quotas unavailable: API-key mode, missing subscription sign-in or unsupported CLI. Use /login claude." }
}

/** Official CLI control messages only: never send a prompt, scan history or read OAuth files. */
export async function claudeUsage(command?: string[], timeout = 15_000): Promise<unknown> {
  const executable = claudeExecutable()
  if (!command && !executable) throw new Error("Install Claude Code CLI")
  const cwd = path.join(Global.Path.cache, "claude-account-workspace")
  await fs.mkdir(cwd, { recursive: true })
  const proc = Bun.spawn(command ?? [executable!, "--print", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--safe-mode", "--tools", "", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--setting-sources", "", "--no-session-persistence"], { cwd, stdin: "pipe", stdout: "pipe", stderr: "ignore", windowsHide: true })
  const timer = setTimeout(() => { if (proc.exitCode === null) proc.kill() }, timeout)
  const init = crypto.randomUUID(), usage = crypto.randomUUID()
  const write = (value: unknown) => { proc.stdin.write(JSON.stringify(value) + "\n"); proc.stdin.flush() }
  write({ type: "control_request", request_id: init, request: { subtype: "initialize" } })
  let bytes = 0, buffer = "", initialized = false
  const decoder = new TextDecoder()
  try {
    for await (const part of proc.stdout) {
      bytes += part.byteLength
      if (bytes > 256 * 1024) throw new Error("Claude account output exceeded limit")
      buffer += decoder.decode(part, { stream: true })
      const lines = buffer.split("\n"); buffer = lines.pop() || ""
      for (const line of lines) {
        if (!line.trim()) continue
        const packet = object(JSON.parse(line))
        if (packet.type === "control_request") {
          write({ type: "control_response", response: { subtype: "error", request_id: packet.request_id, error: "Account client refuses native actions" } })
          throw new Error("Unexpected Claude native request")
        }
        if (packet.type === "assistant" || packet.type === "result") throw new Error("Unexpected Claude inference response")
        if (packet.type !== "control_response") continue
        const response = object(packet.response)
        if (response.request_id !== init && response.request_id !== usage) continue
        if (response.subtype !== "success") throw new Error("Claude usage control unsupported")
        if (response.request_id === init) {
          if (initialized) throw new Error("Duplicate Claude initialization")
          initialized = true
          write({ type: "control_request", request_id: usage, request: { subtype: "get_usage", skip_behaviors: true } })
          continue
        }
        if (!initialized) throw new Error("Claude usage before initialization")
        return response.response
      }
    }
    throw new Error("Claude usage stopped before completion")
  } finally {
    clearTimeout(timer)
    proc.stdin.end()
    if (proc.exitCode === null) proc.kill()
    await proc.exited
  }
}

export async function subscriptionAccount(source: SubscriptionSource, command?: string[]): Promise<SubscriptionAccount> {
  if (source === "cursor") return { source, state: "unavailable", checkedAt: Date.now(), windows: [], detail: "Personal plan allowance isn't exposed by the official SDK. Check Spending in Cursor dashboard. SDK per-run tokens/cost are not subscription allowance; no inference or quota-spending probe performed." }
  const snapshot = await claudeUsage(command).then(value => parseClaudeAccount(value)).catch((): SubscriptionAccount => ({ source, state: "unavailable", checkedAt: Date.now(), windows: [], detail: "Could not read official Claude usage; check CLI compatibility/sign-in. No inference probe was sent." }))
  await (async () => {
    await fs.mkdir(Global.Path.state, {recursive:true})
    const temporary = cache(source) + "." + crypto.randomUUID() + ".tmp"
    await fs.writeFile(temporary, JSON.stringify(snapshot), {mode:0o600})
    await replaceFile(temporary, cache(source))
  })().catch(()=>{})
  return snapshot
}

export async function cachedSubscriptionAccount(source: SubscriptionSource): Promise<SubscriptionAccount | undefined> {
  const raw = await fs.readFile(cache(source), "utf8").then(text=>object(JSON.parse(text))).catch(()=>({} as Record<string,unknown>))
  if (!finite(raw.checkedAt) || !Array.isArray(raw.windows) || !["ready","unavailable"].includes(String(raw.state))) return
  return { source, state: raw.state as "ready" | "unavailable", checkedAt: Number(raw.checkedAt), detail: "Cached official CLI snapshot; refresh to check", windows: raw.windows.slice(0,24).map(value=>{
    const entry=object(value)
    return { label: typeof entry.label === "string" ? entry.label.replace(/[\x00-\x1f\x7f]/g, "").slice(0,80) : "Claude", used: finite(entry.used), minutes: finite(entry.minutes), resetsAt: finite(entry.resetsAt) }
  }) }
}

export const subscriptionRows = (snapshot: SubscriptionAccount): [string,string][] => accountRows(snapshot).map(([label,value]) => [label === "Codex account" ? (snapshot.source === "claude" ? "Claude account" : "Cursor account") : label,value])
