import fs from "fs/promises"
import os from "os"
import path from "path"
import { Global } from "@codegoblin/core/global"
import * as Log from "@codegoblin/core/util/log"
import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3Content,
  LanguageModelV3GenerateResult,
  LanguageModelV3StreamPart,
  LanguageModelV3Usage,
} from "@ai-sdk/provider"
import { ModelID, ProviderID } from "./schema"
import type { Info, Model } from "./provider"
import { antigravityQuotaFrom, captureAntigravityUsage } from "./antigravity-usage"
import { Process } from "@/util/process"
import { BusEvent } from "@/bus/bus-event"
import { GlobalBus } from "@/bus/global"
import { Flock } from "@codegoblin/core/util/flock"
import { Option, Schema } from "effect"

const log = Log.create({ service: "cli-agent" })
const MAX_CLI_LINE = 8 * 1024 * 1024
const MAX_CLI_RESPONSE = 16 * 1024 * 1024
const MAX_CLI_STDERR = 1024 * 1024
const MAX_CLI_TURN_MS = 10 * 60 * 1000
const CLI_DISCOVERY_TTL_MS = 6 * 60 * 60 * 1000
const decodeJson = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)

export const CLI_AGENT_PROVIDERS = ["claude-code", "cursor-agent", "antigravity-cli"] as const
export type CliAgentProviderID = (typeof CLI_AGENT_PROVIDERS)[number]
const CLI_QUOTA_PROVIDERS = [...CLI_AGENT_PROVIDERS, "codex"] as const
export type CliQuotaProviderID = (typeof CLI_QUOTA_PROVIDERS)[number]

export const CliAgentModelsUpdated = BusEvent.define("provider.cli.models.updated", Schema.Struct({}))

export function isCliAgentProvider(value: string): value is CliAgentProviderID {
  return CLI_AGENT_PROVIDERS.includes(value as CliAgentProviderID)
}

type BridgeOptions = {
  sessionID?: string
  directory?: string
  title?: string
  permissionMode?: "agent" | "plan"
  effort?: "low" | "medium" | "high" | "xhigh" | "max"
  executable?: string
  requestWorkspaceTrust?: (directory: string) => Promise<boolean>
  trustWorkspace?: boolean
  /** Kept for saved-config compatibility. Supported structured transports are always used. */
  warmSession?: boolean
}

type BridgeSession = {
  externalSessionID: string
  directory?: string
  lastAssistantText?: string
}

type BridgeSessions = Partial<Record<CliAgentProviderID, Record<string, string | BridgeSession>>>

type ParsedEvent = {
  sessionID?: string
  role?: "user" | "assistant"
  text?: string
  reasoning?: string
  result?: string
  usage?: LanguageModelV3Usage
  error?: string
}

async function limitedText(stream: ReadableStream<Uint8Array>, limit: number) {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let value = ""
  while (true) {
    const next = await reader.read()
    if (next.done) break
    value += decoder.decode(next.value, { stream: true })
    if (value.length > limit) {
      await reader.cancel().catch(() => {})
      throw new Error("CLI output exceeded the safety limit")
    }
  }
  return value + decoder.decode()
}

export type CliAgentQuota = {
  providerID: CliQuotaProviderID
  windows: Array<{ label: string; usedPercentage: number; resetsAt?: string }>
  checkedAt: string
}

const EMPTY_USAGE: LanguageModelV3Usage = {
  inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: undefined, text: undefined, reasoning: undefined },
}

const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const
const CLAUDE_VARIANTS = Object.fromEntries(CLAUDE_EFFORTS.map((effort) => [effort, { effort }]))

type DiscoveredModel = { id: string; name: string }
type DiscoveryCache = Partial<Record<CliAgentProviderID, DiscoveredModel[]>>

let discoveryRefresh: Promise<void> | undefined

let sessionWrite = Promise.resolve()
let usageWrite = Promise.resolve()
let usageRefresh: Promise<CliAgentQuota[]> | undefined
let usageRefreshForced = false
let usageRefreshAt = 0

export function cliAgentProviderInfos(input?: Partial<Record<CliAgentProviderID, DiscoveredModel[]>>): Info[] {
  return [
    providerInfo(
      "claude-code",
      "Claude Code CLI",
      (
        input?.["claude-code"] ?? [
          { id: "default", name: "Claude Code default" },
          { id: "fable", name: "Fable 5" },
          { id: "opus", name: "Opus 4.8" },
          { id: "sonnet", name: "Sonnet 5" },
          { id: "haiku", name: "Haiku 4.5" },
        ]
      ).map((item) => model("claude-code", item.id, item.name, "claude", CLAUDE_VARIANTS)),
    ),
    providerInfo(
      "cursor-agent",
      "Cursor Agent CLI",
      (input?.["cursor-agent"] ?? [{ id: "auto", name: "Auto (Cursor default)" }]).map((item) =>
        model("cursor-agent", item.id, item.name, "cursor"),
      ),
    ),
    providerInfo(
      "antigravity-cli",
      "Antigravity CLI",
      (input?.["antigravity-cli"] ?? [{ id: "default", name: "Antigravity CLI default" }]).map((item) =>
        model("antigravity-cli", item.id, item.name, "antigravity"),
      ),
    ),
  ]
}

export function mergeCliAgentProviderModels(
  current: Info,
  discovered: Info,
  configured?: {
    blacklist?: string[]
    whitelist?: string[]
    models?: Record<string, { name?: string }>
  },
) {
  const models = Object.fromEntries(
    Object.entries(discovered.models).map(([modelID, model]) => [
      modelID,
      current.models[modelID]
        ? {
            ...model,
            ...current.models[modelID],
            name: configured?.models?.[modelID]?.name ?? model.name,
          }
        : model,
    ]),
  )
  return {
    ...current,
    models: Object.fromEntries(
      Object.entries({ ...current.models, ...models }).filter(
        ([modelID]) =>
          !configured?.blacklist?.includes(modelID) &&
          (!configured?.whitelist || configured.whitelist.includes(modelID)),
      ),
    ),
  }
}

export async function discoverCliAgentProviderInfos() {
  const [cached, fresh] = await Promise.all([readDiscoveryCache(), discoveryCacheFresh()])
  if ((!cached || !fresh) && !discoveryRefresh) {
    discoveryRefresh = refreshDiscoveryCache()
      .then((changed) => {
        if (!changed) return
        GlobalBus.emit("event", {
          directory: "global",
          payload: { type: CliAgentModelsUpdated.type, properties: {} },
        })
      })
      .catch((error) =>
        log.warn("CLI model discovery refresh failed", { error: error instanceof Error ? error.message : error }),
      )
      .finally(() => {
        discoveryRefresh = undefined
      })
  }
  // Discovery is intentionally off the startup path. Do not memoize this
  // result: once the background refresh writes the cache, the next provider
  // list request must see the newly installed CLI models without a restart.
  return cliAgentProviderInfos(cached)
}

async function discoveryCacheFresh() {
  const info = await fs.stat(path.join(Global.Path.data, "cli-agent-models.json")).catch(() => undefined)
  return Boolean(info && Date.now() - info.mtimeMs < CLI_DISCOVERY_TTL_MS)
}

async function readDiscoveryCache(): Promise<DiscoveryCache | undefined> {
  const file = Bun.file(path.join(Global.Path.data, "cli-agent-models.json"))
  if (!(await file.exists())) return
  const value = await file.json().catch(() => undefined)
  if (!isRecord(value)) return
  const entries = CLI_AGENT_PROVIDERS.flatMap((providerID) => {
    const models = value[providerID]
    if (!Array.isArray(models)) return []
    const valid = models.flatMap((item) => {
      if (!isRecord(item)) return []
      const id = stringValue(item.id)
      const name = stringValue(item.name)
      if (!id) return []
      if (providerID === "antigravity-cli") {
        const parsed = antigravityModel(id, name)
        return parsed ? [parsed] : []
      }
      return id && name ? [{ id, name }] : []
    })
    return valid.length ? ([[providerID, valid]] as const) : []
  })
  return Object.fromEntries(entries)
}

export function mergeCliAgentDiscoveryCache(current: DiscoveryCache, discovered: DiscoveryCache) {
  const cache = { ...current, ...discovered }
  return {
    cache,
    changed: JSON.stringify(current) !== JSON.stringify(cache),
  }
}

async function refreshDiscoveryCache() {
  const [cursor, antigravity] = await Promise.all([discoverCursorModels(), discoverAntigravityModels()])
  const discovered = {
    ...(cursor.length && { "cursor-agent": cursor }),
    ...(antigravity.length && { "antigravity-cli": antigravity }),
  }
  const file = path.join(Global.Path.data, "cli-agent-models.json")
  return Flock.withLock(file, async () => {
    // Discovery can take tens of seconds. Another CodeGoblin process may have
    // refreshed the file while the probes ran, so only merge against state read
    // after acquiring the cross-process lock.
    const merged = mergeCliAgentDiscoveryCache((await readDiscoveryCache()) ?? {}, discovered)
    const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(temporary, JSON.stringify(merged.cache, null, 2))
    await fs.rename(temporary, file).catch(async (error) => {
      await fs.rm(temporary, { force: true }).catch(() => {})
      throw error
    })
    return merged.changed
  })
}

async function discoverCursorModels() {
  const executable = cliAgentExecutable("cursor-agent")
  if (!executable) return []
  const result = await runDiscovery([...cliAgentBaseCommand("cursor-agent", executable), "models"])
  if (!result) return []
  return parseCursorModelLines(result)
}

async function discoverAntigravityModels() {
  const executable = cliAgentExecutable("antigravity-cli")
  if (!executable) return []
  // `agy models` measured ~13s on a warm machine, so a 15s budget loses the
  // race often enough that the provider silently falls back to a placeholder
  // id that then fails to resolve. Give it real headroom.
  const result = await runDiscovery(
    [...cliAgentBaseCommand("antigravity-cli", executable), "models"],
    45_000,
    await antigravityEnvironment(),
  )
  if (!result) return []
  return parseAntigravityModelLines(result)
}

export type CliAgentQuotaStatus = {
  providerID: CliQuotaProviderID
  label: string
  available: boolean
  reason: string
}

export function parseCursorModelLines(value: string) {
  return value
    .replace(/\x1b\[[0-9;]*m/g, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .flatMap((line) => {
      const match = /^(\S+)\s+-\s+(.+)$/.exec(line)
      if (!match || /^tip:/i.test(line) || /^(available )?models?:?$/i.test(line)) return []
      const [, id, displayName] = match
      return [
        {
          id,
          name: id === "auto" ? "Auto (Cursor default)" : displayName.replace(/\s+\(current(?:,\s*default)?\)$/i, ""),
        },
      ]
    })
}

export function parseAntigravityModelLines(value: string) {
  return value
    .replace(/\x1b\[[0-9;]*m/g, "")
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^[>*●•-]\s*/, ""))
    .flatMap((line) => {
      if (!line || /^(available )?models?:?$/i.test(line) || /^(tip:|fetching available models)/i.test(line)) return []
      const parsed = antigravityModel(line)
      return parsed ? [parsed] : []
    })
}

function antigravityModel(value: string, fallbackName?: string) {
  const [id, reportedName] = value.split(/\t+/, 2).map((part) => part.trim())
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(id)) return
  return { id, name: reportedName || fallbackName || displayAntigravityModel(id) }
}

function displayAntigravityModel(id: string) {
  const parts = id.split("-")
  const effort = ["low", "medium", "high", "thinking", "max"].includes(parts.at(-1) ?? "") ? parts.pop() : undefined
  const base = parts.join(" ").replace(/(\d) (\d)$/, "$1.$2")
  const name = base
    .split(" ")
    .map((part) => {
      if (/^gpt$/i.test(part)) return "GPT"
      if (/^oss$/i.test(part)) return "OSS"
      if (/^\d+b$/i.test(part)) return part.toUpperCase()
      return part.charAt(0).toUpperCase() + part.slice(1)
    })
    .join(" ")
  return effort ? `${name} (${effort.charAt(0).toUpperCase()}${effort.slice(1)})` : name
}

/**
 * Whether this `agy` understands `--output-format`. Structured streaming landed
 * in 1.1.8; older builds treat the unknown flag as an error and drop into help
 * mode, so probe the CLI's own help text rather than assuming a version.
 */
let antigravityStreamSupport: Promise<boolean> | undefined
export function antigravitySupportsStreamJson(executable: string) {
  antigravityStreamSupport ??= (async () => {
    const help = await runDiscovery([executable, "--help"], 20_000)
    return Boolean(help && /--output-format/.test(help))
  })().catch(() => false)
  return antigravityStreamSupport
}

let claudeIsolationSupport: Promise<string[]> | undefined
async function claudeIsolationFlags(executable: string) {
  claudeIsolationSupport ??= (async () => {
    const help = await runDiscovery([executable, "--help"], 20_000)
    if (/--safe-mode/.test(help ?? "")) return ["--safe-mode"]
    throw new Error(
      "Claude Code cannot be isolated safely. Update Claude Code to a version that supports --safe-mode and retry.",
    )
  })().catch((error) => {
    claudeIsolationSupport = undefined
    throw error
  })
  return claudeIsolationSupport
}

let antigravityEnvironmentPromise: Promise<NodeJS.ProcessEnv> | undefined
function antigravityEnvironment() {
  antigravityEnvironmentPromise ??= createAntigravityEnvironment()
  return antigravityEnvironmentPromise
}

async function createAntigravityEnvironment() {
  // AGY loads every global MCP server from ~/.gemini/config before handling a
  // print request. Give the bridge an empty config home so a chat turn cannot
  // open terminal windows or pay for unrelated MCP startup. Native conversation
  // and brain directories remain linked so known session IDs are still directly
  // resumable by AGY without copying or editing its database files.
  const home = path.join(Global.Path.data, "cli-agent-home", "antigravity")
  const app = path.join(home, ".gemini", "antigravity-cli")
  await Promise.all([
    fs.mkdir(path.join(home, ".gemini", "config"), { recursive: true }),
    fs.mkdir(app, { recursive: true }),
  ])
  const native = path.join(os.homedir(), ".gemini", "antigravity-cli")
  await Promise.all(
    ["conversations", "brain"].map(async (name) => {
      const target = path.join(native, name)
      await fs.mkdir(target, { recursive: true })
      const link = path.join(app, name)
      if (await fs.lstat(link).catch(() => undefined)) return
      await fs.symlink(target, link, process.platform === "win32" ? "junction" : "dir").catch((error) =>
        log.warn("failed to link Antigravity session storage", {
          name,
          error: error instanceof Error ? error.message : error,
        }),
      )
    }),
  )
  return {
    ...process.env,
    HOME: home,
    ...(process.platform === "win32" && { USERPROFILE: home }),
  }
}

async function runDiscovery(command: string[], timeoutMs = 15_000, env: NodeJS.ProcessEnv = process.env) {
  const proc = Bun.spawn(command, {
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
    windowsHide: process.platform === "win32",
  })
  const timeout = setTimeout(() => stopCliAgentProcess(proc), timeoutMs)
  const [exitCode, stdout] = await Promise.all([
    proc.exited,
    limitedText(proc.stdout, MAX_CLI_STDERR).catch((error) => {
      stopCliAgentProcess(proc)
      return error instanceof Error ? error : new Error(String(error))
    }),
  ])
  clearTimeout(timeout)
  if (exitCode !== 0 || stdout instanceof Error) return
  return stdout.trim()
}

export function createCliAgentLanguageModel(
  providerID: CliAgentProviderID,
  modelID: string,
  options: Record<string, unknown>,
): LanguageModelV3 {
  const defaults = options as BridgeOptions
  return {
    specificationVersion: "v3",
    provider: providerID,
    modelId: modelID,
    supportedUrls: {},
    async doGenerate(input) {
      const result = await this.doStream(input)
      const content: LanguageModelV3Content[] = []
      let text = ""
      let reasoning = ""
      let usage = EMPTY_USAGE
      let finishReason: LanguageModelV3GenerateResult["finishReason"] = { unified: "other", raw: undefined }
      const reader = result.stream.getReader()
      while (true) {
        const next = await reader.read()
        if (next.done) break
        const part = next.value
        if (part.type === "text-delta") text += part.delta
        if (part.type === "reasoning-delta") reasoning += part.delta
        if (part.type === "finish") {
          usage = part.usage
          finishReason = part.finishReason
        }
        if (part.type === "error") throw part.error
      }
      if (reasoning) content.push({ type: "reasoning", text: reasoning })
      if (text) content.push({ type: "text", text })
      return { content, finishReason, usage, warnings: [] }
    },
    async doStream(input) {
      const bridge = {
        ...defaults,
        ...(input.providerOptions?.[providerID] as BridgeOptions | undefined),
      }
      const sessionID = bridge.sessionID
      if (!sessionID) throw new Error(`${providerName(providerID)} bridge did not receive a CodeGoblin session ID`)
      const executable = bridge.executable || cliAgentExecutable(providerID)
      if (!executable) throw new Error(missingExecutableMessage(providerID))

      const sessions = await readSessions()
      const remembered = sessions[providerID]?.[sessionID]
      const forked =
        typeof remembered !== "string" &&
        remembered?.lastAssistantText !== undefined &&
        remembered.lastAssistantText !== lastAssistantText(input)
      const externalSessionID = forked
        ? undefined
        : typeof remembered === "string"
          ? remembered
          : remembered?.externalSessionID
      const newSessionID = forked ? deterministicCliSessionID(`${sessionID}:${crypto.randomUUID()}`) : undefined
      const prompt = promptText(input, !externalSessionID, providerID === "antigravity-cli" ? 20_000 : undefined)
      const logFile =
        providerID === "antigravity-cli"
          ? path.join(Global.Path.data, `antigravity-${sessionID}-${crypto.randomUUID()}.log`)
          : undefined
      const cwd =
        bridge.directory || (typeof remembered === "string" ? undefined : remembered?.directory) || process.cwd()
      const trustWorkspace =
        providerID !== "cursor-agent"
          ? bridge.trustWorkspace
          : bridge.trustWorkspace === true
            ? true
            : await bridge.requestWorkspaceTrust?.(cwd)
      if (providerID === "cursor-agent" && trustWorkspace !== true) {
        throw new Error(
          `Cursor Agent needs workspace trust for ${cwd}. Approve the trust request in CodeGoblin and retry.`,
        )
      }
      const command = buildCliAgentCommand({
        providerID,
        executable,
        modelID,
        externalSessionID,
        sessionID,
        newSessionID,
        permissionMode: bridge.permissionMode ?? "agent",
        effort: bridge.effort,
        logFile,
        prompt,
        title: bridge.title,
        trustWorkspace,
        streamJson: providerID === "antigravity-cli" ? await antigravitySupportsStreamJson(executable) : undefined,
        isolationFlags: providerID === "claude-code" ? await claudeIsolationFlags(executable) : undefined,
      })
      const proc = Bun.spawn(command, {
        cwd,
        env: providerID === "antigravity-cli" ? await antigravityEnvironment() : process.env,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        windowsHide: process.platform === "win32",
      })
      if (providerID !== "antigravity-cli") {
        proc.stdin.write(prompt)
      }
      proc.stdin.end()

      const abort = () => stopCliAgentProcess(proc)
      const timeout = setTimeout(() => stopCliAgentProcess(proc), MAX_CLI_TURN_MS)
      input.abortSignal?.addEventListener("abort", abort, { once: true })

      return {
        stream: new ReadableStream<LanguageModelV3StreamPart>({
          async start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] })
            const stderrPromise = limitedText(proc.stderr, MAX_CLI_STDERR).catch((error) => {
              stopCliAgentProcess(proc)
              return error instanceof Error ? error.message : "CLI stderr exceeded the safety limit"
            })
            let buffer = ""
            let textStarted = false
            let reasoningStarted = false
            let emittedText = false
            let responseText = ""
            let usage = EMPTY_USAGE
            let discoveredSessionID = externalSessionID
            const emitText = (delta: string) => {
              if (!delta) return
              if (!textStarted) {
                controller.enqueue({ type: "text-start", id: "text-0" })
                textStarted = true
              }
              controller.enqueue({ type: "text-delta", id: "text-0", delta })
              emittedText = true
              responseText += delta
              if (responseText.length > MAX_CLI_RESPONSE) {
                stopCliAgentProcess(proc)
                throw new Error("CLI response exceeded the safety limit")
              }
            }
            const emitReasoning = (delta: string) => {
              if (!delta) return
              if (!reasoningStarted) {
                controller.enqueue({ type: "reasoning-start", id: "reasoning-0" })
                reasoningStarted = true
              }
              controller.enqueue({ type: "reasoning-delta", id: "reasoning-0", delta })
            }
            const handle = async (line: string) => {
              const event = parseCliAgentEvent(providerID, line)
              if (!event) return
              if (event.sessionID && event.sessionID !== discoveredSessionID) {
                discoveredSessionID = event.sessionID
                await rememberSession(providerID, sessionID, event.sessionID, bridge.directory, responseText)
              }
              if (event.reasoning) emitReasoning(event.reasoning)
              if (event.role !== "user" && event.text) emitText(event.text)
              if (!emittedText && event.result) emitText(event.result)
              if (event.usage) usage = event.usage
              if (event.error) throw new Error(event.error)
            }

            try {
              const reader = proc.stdout.getReader()
              const decoder = new TextDecoder()
              while (true) {
                const next = await reader.read()
                if (next.done) break
                buffer += decoder.decode(next.value, { stream: true })
                if (buffer.length > MAX_CLI_LINE) {
                  stopCliAgentProcess(proc)
                  throw new Error("CLI stream record exceeded the safety limit")
                }
                const lines = buffer.split(/\r?\n/)
                buffer = lines.pop() ?? ""
                for (const line of lines) await handle(line)
              }
              buffer += decoder.decode()
              if (buffer.trim()) await handle(buffer)
              const exitCode = await proc.exited
              const stderr = (await stderrPromise).trim()
              if (exitCode !== 0) throw new Error(cliFailureMessage(providerID, stderr, exitCode))
              if (!discoveredSessionID && providerID === "antigravity-cli" && logFile) {
                const log = await Bun.file(logFile)
                  .slice(0, MAX_CLI_STDERR)
                  .text()
                  .catch(() => "")
                discoveredSessionID = /Created conversation ([0-9a-f-]{36})/i.exec(log)?.[1]
                if (discoveredSessionID) {
                  await rememberSession(providerID, sessionID, discoveredSessionID, bridge.directory, responseText)
                }
              }
              if (!discoveredSessionID && providerID === "claude-code") {
                discoveredSessionID = newSessionID ?? deterministicCliSessionID(sessionID)
                await rememberSession(providerID, sessionID, discoveredSessionID, bridge.directory, responseText)
              }
              if (discoveredSessionID) {
                await rememberSession(providerID, sessionID, discoveredSessionID, bridge.directory, responseText)
              }
              if (reasoningStarted) controller.enqueue({ type: "reasoning-end", id: "reasoning-0" })
              if (textStarted) controller.enqueue({ type: "text-end", id: "text-0" })
              controller.enqueue({
                type: "finish",
                usage,
                finishReason: { unified: "stop", raw: "cli-complete" },
                providerMetadata: {
                  [providerID]: {
                    sessionID: discoveredSessionID ?? null,
                    transport: "local-cli",
                  },
                },
              })
              controller.close()
            } catch (error) {
              stopCliAgentProcess(proc)
              controller.error(error)
            } finally {
              clearTimeout(timeout)
              if (logFile)
                await Bun.file(logFile)
                  .delete()
                  .catch(() => {})
              input.abortSignal?.removeEventListener("abort", abort)
            }
          },
          cancel() {
            stopCliAgentProcess(proc)
          },
        }),
        request: { body: { transport: "local-cli", providerID, modelID } },
      }
    },
  }
}

function providerInfo(id: CliAgentProviderID, name: string, models: Model[]): Info {
  return {
    id: ProviderID.make(id),
    name,
    source: "custom",
    env: [],
    options: {},
    models: Object.fromEntries(models.map((item) => [item.id, item])),
  }
}

function model(
  provider: CliAgentProviderID,
  id: string,
  name: string,
  family: string,
  variants: Record<string, Record<string, unknown>> = {},
): Model {
  return {
    id: ModelID.make(id),
    providerID: ProviderID.make(provider),
    name,
    family,
    api: { id, npm: "@codegoblin/cli-agent", url: "" },
    status: "active",
    headers: {},
    options: {},
    capabilities: {
      temperature: false,
      reasoning: true,
      attachment: false,
      toolcall: false,
      input: { text: true, audio: false, image: false, video: false, pdf: false },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: false,
    },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: 200_000, output: 32_000 },
    release_date: "",
    variants,
  }
}

export function cliAgentModel(providerID: CliAgentProviderID, modelID: string) {
  if (providerID === "antigravity-cli") {
    return model(providerID, modelID, displayAntigravityModel(modelID), "antigravity")
  }
  if (providerID === "cursor-agent") {
    return model(providerID, modelID, modelID === "auto" ? "Auto (Cursor default)" : modelID, "cursor")
  }
  const name = {
    default: "Claude Code default",
    fable: "Fable 5",
    opus: "Opus 4.8",
    sonnet: "Sonnet 5",
    haiku: "Haiku 4.5",
  }[modelID]
  return model(providerID, modelID, name ?? modelID, "claude", CLAUDE_VARIANTS)
}

export function cliAgentExecutable(providerID: CliAgentProviderID) {
  const env = {
    "claude-code": "CODEGOBLIN_CLAUDE_CLI",
    "cursor-agent": "CODEGOBLIN_CURSOR_CLI",
    "antigravity-cli": "CODEGOBLIN_ANTIGRAVITY_CLI",
  }[providerID]
  const command = { "claude-code": "claude", "cursor-agent": "cursor-agent", "antigravity-cli": "agy" }[providerID]
  const executable = process.env[env] || Bun.which(command)
  if (executable) return executable
  if (providerID === "claude-code") {
    for (const candidate of claudeAgentCandidates()) {
      if (Bun.file(candidate).size > 0) return candidate
    }
  }
  if (providerID === "antigravity-cli") {
    // `agy` is commonly installed somewhere that is not on PATH yet (a fresh
    // install before the shell is restarted, or a non-login shell), and unlike
    // the other CLIs it had no fallback — so it silently vanished from the
    // model list on machines where PATH lookup missed it.
    for (const candidate of antigravityAgentCandidates()) {
      if (Bun.file(candidate).size > 0) return candidate
    }
    return
  }
  if (providerID !== "cursor-agent" || process.platform !== "win32") return
  for (const command of ["agent", "cursor-agent"]) {
    const fromPath = Bun.which(command)
    if (fromPath) return fromPath
  }
  for (const candidate of cursorAgentCandidates()) {
    if (Bun.file(candidate).size > 0) return candidate
  }
}

export function claudeAgentCandidates(env: NodeJS.ProcessEnv = process.env, platform = process.platform) {
  const home = platform === "win32" ? env.USERPROFILE : env.HOME
  if (!home) return []
  // Join with the *target* platform's rules, not the host's: `path.join` would
  // emit forward slashes for Windows candidates when this runs on Linux.
  const join = platform === "win32" ? path.win32.join : path.posix.join
  const launchers = platform === "win32" ? ["claude.exe", "claude.cmd", "claude.ps1"] : ["claude"]
  return launchers.map((launcher) => join(home, ".local", "bin", launcher))
}

export function antigravityAgentCandidates(env: NodeJS.ProcessEnv = process.env, platform = process.platform) {
  // Join with the *target* platform's rules, not the host's: `path.join` would
  // emit backslashes while resolving posix candidates on a Windows dev box.
  if (platform === "win32") {
    const root = env.LOCALAPPDATA
    if (!root) return []
    return [path.win32.join(root, "agy", "bin", "agy.exe"), path.win32.join(root, "agy", "bin", "agy.cmd")]
  }
  const home = env.HOME
  if (!home) return []
  return [
    path.posix.join(home, ".local", "bin", "agy"),
    path.posix.join(home, ".antigravity", "bin", "agy"),
    "/usr/local/bin/agy",
    "/opt/homebrew/bin/agy",
  ]
}

export function cursorAgentCandidates(env: NodeJS.ProcessEnv = process.env, platform = process.platform) {
  // Windows-only by definition, so always join with Windows rules — the host
  // running this (CI on Linux, for one) is not the platform being described.
  if (platform !== "win32" || !env.LOCALAPPDATA) return []
  const root = path.win32.join(env.LOCALAPPDATA, "cursor-agent")
  const launchers = ["cursor-agent.exe", "cursor-agent.cmd", "cursor-agent.ps1", "agent.exe", "agent.cmd", "agent.ps1"]
  return [
    ...launchers.map((launcher) => path.win32.join(root, launcher)),
    ...launchers.map((launcher) => path.win32.join(root, "versions", "current", launcher)),
  ]
}

export function cliAgentBaseCommand(providerID: CliAgentProviderID, executable: string) {
  if (providerID === "cursor-agent" && /(?:^|[\\/])wsl(?:\.exe)?$/i.test(executable)) {
    return [executable, "cursor-agent"]
  }
  return [executable]
}

export function cliAgentResumeCommand(providerID: CliAgentProviderID, executable: string, externalSessionID: string) {
  if (providerID === "claude-code") return [executable, "--resume", externalSessionID]
  if (providerID === "cursor-agent") {
    return [...cliAgentBaseCommand(providerID, executable), "--resume", externalSessionID]
  }
  return [...cliAgentBaseCommand(providerID, executable), "--conversation", externalSessionID]
}

export function buildCliAgentCommand(input: {
  providerID: CliAgentProviderID
  executable: string
  modelID: string
  externalSessionID?: string
  sessionID: string
  newSessionID?: string
  permissionMode: "agent" | "plan"
  effort?: "low" | "medium" | "high" | "xhigh" | "max"
  logFile?: string
  prompt?: string
  title?: string
  trustWorkspace?: boolean
  /** AGY only: request the typed NDJSON stream (1.1.8+). */
  streamJson?: boolean
  /** Claude only: supported flags that disable inherited hooks/plugins/MCPs. */
  isolationFlags?: string[]
}) {
  if (input.providerID === "claude-code") {
    const external = input.externalSessionID ?? input.newSessionID ?? deterministicCliSessionID(input.sessionID)
    return [
      input.executable,
      ...(input.isolationFlags ?? []),
      // Claude persists --print sessions unless --no-session-persistence is
      // supplied. The explicit UUID below is therefore resumable in Claude's
      // native CLI without keeping a hidden interactive process alive.
      "--print",
      "--input-format",
      "text",
      "--output-format",
      "stream-json",
      "--include-partial-messages",
      "--verbose",
      "--permission-mode",
      input.permissionMode === "plan" ? "plan" : "auto",
      ...(input.effort ? ["--effort", input.effort] : []),
      ...(input.modelID === "default" ? [] : ["--model", input.modelID]),
      ...(!input.externalSessionID && input.title?.trim() ? ["--name", input.title.trim().slice(0, 80)] : []),
      ...(input.externalSessionID ? ["--resume", external] : ["--session-id", external]),
    ]
  }
  if (input.providerID === "antigravity-cli") {
    return [
      ...cliAgentBaseCommand(input.providerID, input.executable),
      // AGY 1.1.12 requires the prompt as this flag's value. It does not read
      // the prompt from stdin (a bare --print consumes the following flag as
      // its prompt), so do not log or persist this command array.
      ...(input.prompt !== undefined ? [`--print=${input.prompt}`] : ["--print"]),
      // AGY 1.1.8+ streams typed NDJSON events as it works. Without this the
      // CLI stays silent until the whole run finishes, which is why a turn
      // looked frozen for a minute; with it the first event lands in ~3s.
      // Older builds reject the flag, so it is only sent when supported.
      ...(input.streamJson ? ["--output-format", "stream-json"] : []),
      ...(input.modelID === "default" ? [] : ["--model", input.modelID]),
      ...(input.externalSessionID ? ["--conversation", input.externalSessionID] : []),
      "--mode",
      input.permissionMode === "plan" ? "plan" : "accept-edits",
      ...(input.logFile ? ["--log-file", input.logFile] : []),
    ]
  }
  return [
    ...cliAgentBaseCommand(input.providerID, input.executable),
    "--print",
    "--output-format",
    "stream-json",
    ...(input.trustWorkspace === true ? ["--trust"] : []),
    ...(input.modelID === "default" ? [] : ["--model", input.modelID]),
    ...(input.externalSessionID ? [`--resume=${input.externalSessionID}`] : []),
  ]
}

function promptText(input: LanguageModelV3CallOptions, full: boolean, maxChars?: number) {
  const messages = full
    ? input.prompt.filter((item) => item.role !== "system")
    : input.prompt.filter((item) => item.role === "user").slice(-1)
  const rendered = messages.flatMap((message) => {
    const text = message.content
      .flatMap((part) => {
        if (part.type === "text") return [part.text]
        if (part.type === "reasoning") return []
        if (part.type === "file") return [`[Attached file: ${part.filename ?? part.mediaType}]`]
        if (part.type === "tool-call") return [`[Tool call: ${part.toolName}]`]
        if (part.type === "tool-result") return [`[Tool result: ${part.toolName}]`]
        return []
      })
      .filter(Boolean)
      .join("\n")
    if (!text) return []
    return full ? [`${message.role === "assistant" ? "Assistant" : "User"}:\n${text}`] : [text]
  })
  if (!rendered.length) throw new Error("The local CLI bridge could not find a user text prompt to send")
  const prompt = rendered.join("\n\n")
  if (!maxChars || prompt.length <= maxChars) return prompt
  return `[Earlier conversation omitted to fit the local CLI limit]\n\n${prompt.slice(-(maxChars - 60))}`
}

function lastAssistantText(input: LanguageModelV3CallOptions) {
  const assistant = input.prompt.findLast((message) => message.role === "assistant")
  if (!assistant) return
  return assistant.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("")
}

export function parseCliAgentEvent(providerID: CliAgentProviderID, line: string): ParsedEvent | undefined {
  if (!line.trim()) return
  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(line) as Record<string, unknown>
  } catch {
    if (providerID === "antigravity-cli") return { text: `${line}\n` }
    return { text: line }
  }

  const sessionID = stringValue(raw.session_id) ?? stringValue(raw.sessionId)
  if (providerID === "antigravity-cli") return parseAntigravityEvent(raw, sessionID)
  if (raw.type === "user" || (raw.role === "user" && contentText(raw.content))) {
    return { sessionID, role: "user", text: contentText(raw.content) }
  }
  if (raw.type === "stream_event" && isRecord(raw.event)) {
    const event = raw.event
    if (event.type === "content_block_delta" && isRecord(event.delta)) {
      if (event.delta.type === "text_delta") return { sessionID, text: stringValue(event.delta.text) }
      if (event.delta.type === "thinking_delta") return { sessionID, reasoning: stringValue(event.delta.thinking) }
    }
  }

  if (raw.type === "assistant" && isRecord(raw.message)) {
    const text = contentText(raw.message.content)
    return { sessionID, text: providerID === "cursor-agent" ? text : undefined }
  }

  if (raw.type === "result") {
    const usage = usageFrom(raw.usage)
    const error =
      raw.is_error === true ? (stringValue(raw.result) ?? "The local agent CLI returned an error") : undefined
    return { sessionID, result: stringValue(raw.result), usage, error }
  }

  if (raw.type === "error") return { sessionID, error: stringValue(raw.message) ?? stringValue(raw.error) }
  return { sessionID }
}

/**
 * AGY 1.1.8's `stream-json` vocabulary:
 *   init        → { conversation_id, init: { model, cwd, tools } }
 *   step_update → { step_update: { conversation_id, step_index, state, step_type,
 *                   tool_info?, tool_name?, text_delta?, usage? } }
 *   result      → { result: { conversation_id, status, response, usage } }
 *
 * These are typed and officially supported, so nothing here guesses: tool
 * activity comes from real `tool` steps, and no text is presented as model
 * reasoning (AGY does not expose hidden chain-of-thought).
 */
function parseAntigravityEvent(raw: Record<string, unknown>, sessionID?: string): ParsedEvent | undefined {
  const event = stringValue(raw.event)

  if (event === "init") {
    return {
      sessionID: stringValue(raw.conversation_id) ?? sessionID,
      reasoning: "Antigravity started the session\n",
    }
  }

  if (event === "step_update") {
    const step = isRecord(raw.step_update) ? raw.step_update : {}
    const id = stringValue(step.conversation_id) ?? sessionID
    const stepType = stringValue(step.step_type)
    const state = stringValue(step.state)

    if (stepType === "tool") {
      // Announce once, when the tool starts; the DONE echo would duplicate it.
      if (state !== "ACTIVE") return { sessionID: id }
      const info = isRecord(step.tool_info) ? step.tool_info : undefined
      const name = stringValue(info?.name) ?? stringValue(step.tool_name)
      return { sessionID: id, reasoning: name ? `${name.replace(/_/g, " ")}\n` : undefined }
    }

    if (stepType === "agent_response") {
      return {
        sessionID: id,
        role: "assistant",
        text: stringValue(step.text_delta),
        usage: antigravityUsage(step.usage),
      }
    }

    // user_input / checkpoint / unknown carry no user-facing content.
    return { sessionID: id }
  }

  if (event === "result") {
    const result = isRecord(raw.result) ? raw.result : {}
    const id = stringValue(result.conversation_id) ?? sessionID
    const status = stringValue(result.status)
    if (status && status.toUpperCase() !== "SUCCESS") {
      return { sessionID: id, error: `Antigravity run ${status.toLowerCase()}` }
    }
    return { sessionID: id, result: stringValue(result.response), usage: antigravityUsage(result.usage) }
  }

  // Legacy AGY (pre-1.1.8, no --output-format): plain records keyed by
  // source/type. Kept so older installs keep working rather than silently
  // producing empty replies.
  const source = stringValue(raw.source)
  const legacyType = stringValue(raw.type)?.toUpperCase()
  if (source || legacyType) {
    if (source === "USER_EXPLICIT" || legacyType === "USER_INPUT") {
      return { sessionID, role: "user", text: stringValue(raw.content) }
    }
    if (
      source !== "MODEL" &&
      legacyType !== "ASSISTANT" &&
      legacyType !== "RESPONSE" &&
      legacyType !== "PLANNER_RESPONSE"
    ) {
      return { sessionID }
    }
    return {
      sessionID,
      role: "assistant",
      text: stringValue(raw.content) ?? contentText(raw.message),
      reasoning: stringValue(raw.thinking) ?? stringValue(raw.reasoning),
    }
  }

  return undefined
}

function antigravityUsage(value: unknown): LanguageModelV3Usage | undefined {
  if (!isRecord(value)) return undefined
  const num = (key: string) => (typeof value[key] === "number" ? (value[key] as number) : undefined)
  const input = num("input_tokens")
  const output = num("output_tokens")
  if (input === undefined && output === undefined) return undefined
  const cacheRead = num("cache_read_tokens")
  return {
    inputTokens: { total: input, noCache: input, cacheRead, cacheWrite: undefined },
    outputTokens: { total: output, text: output, reasoning: num("thinking_tokens") },
  }
}

function contentText(value: unknown) {
  if (typeof value === "string") return value
  if (!Array.isArray(value)) return
  return value
    .flatMap((part) => (isRecord(part) && part.type === "text" && typeof part.text === "string" ? [part.text] : []))
    .join("")
}

function usageFrom(value: unknown): LanguageModelV3Usage | undefined {
  if (!isRecord(value)) return
  const input = numberValue(value.input_tokens) ?? numberValue(value.inputTokens)
  const output = numberValue(value.output_tokens) ?? numberValue(value.outputTokens)
  const cacheRead = numberValue(value.cache_read_input_tokens) ?? numberValue(value.cacheReadInputTokens)
  const cacheWrite = numberValue(value.cache_creation_input_tokens) ?? numberValue(value.cacheCreationInputTokens)
  const totalInput = input === undefined ? undefined : input + (cacheRead ?? 0) + (cacheWrite ?? 0)
  return {
    inputTokens: {
      total: totalInput,
      noCache: input,
      cacheRead,
      cacheWrite,
    },
    outputTokens: { total: output, text: output, reasoning: undefined },
    raw: value as LanguageModelV3Usage["raw"],
  }
}

export function deterministicCliSessionID(value: string) {
  const hex = Array.from(new Uint8Array(new Bun.CryptoHasher("sha256").update(value).digest()))
    .slice(0, 16)
    .map((byte) => byte.toString(16).padStart(2, "0"))
  hex[6] = ((Number.parseInt(hex[6], 16) & 0x0f) | 0x40).toString(16).padStart(2, "0")
  hex[8] = ((Number.parseInt(hex[8], 16) & 0x3f) | 0x80).toString(16).padStart(2, "0")
  const joined = hex.join("")
  return `${joined.slice(0, 8)}-${joined.slice(8, 12)}-${joined.slice(12, 16)}-${joined.slice(16, 20)}-${joined.slice(20)}`
}

async function readSessions(): Promise<BridgeSessions> {
  const file = Bun.file(cliAgentSessionFile())
  if (!(await file.exists())) return {}
  return file.json().catch(() => ({}))
}

async function rememberSession(
  providerID: CliAgentProviderID,
  sessionID: string,
  externalSessionID: string,
  directory?: string,
  lastAssistantText?: string,
) {
  sessionWrite = sessionWrite
    .catch(() => {})
    .then(async () => {
      const sessions = await readSessions()
      sessions[providerID] = {
        ...sessions[providerID],
        [sessionID]: {
          externalSessionID,
          ...(directory && { directory }),
          ...(lastAssistantText !== undefined && { lastAssistantText }),
        },
      }
      await Bun.write(cliAgentSessionFile(), JSON.stringify(sessions, null, 2))
    })
  await sessionWrite
}

export function cliAgentSessionFile() {
  return path.join(Global.Path.data, "cli-agent-sessions.json")
}

export async function readCliAgentUsage(): Promise<CliAgentQuota[]> {
  const file = Bun.file(path.join(Global.Path.data, "cli-agent-usage.json"))
  if (!(await file.exists())) return []
  const value = await file.json().catch(() => [])
  return Array.isArray(value) ? (value as CliAgentQuota[]) : []
}

export function parseClaudeQuota(value: unknown): CliAgentQuota | undefined {
  if (!isRecord(value)) return
  const result = stringValue(value.result)
  if (!result) return
  const parsed = result.split(/\r?\n/).flatMap((line) => {
    const match =
      /^Current (session|5[- ]hour|week \(all models\)):\s*(\d+(?:\.\d+)?)% used(?:\s*·\s*resets (.+))?/i.exec(
        line.trim(),
      )
    if (!match) return []
    const label = match[1].toLowerCase().startsWith("week") ? "week" : "5h"
    return [
      {
        label,
        usedPercentage: Number(match[2]),
        ...(match[3] && { resetsAt: match[3] }),
        explicit: !match[1].toLowerCase().startsWith("session"),
      },
    ]
  })
  const windows = ["5h", "week"].flatMap((label) => {
    const matches = parsed.filter((item) => item.label === label)
    const selected = matches.find((item) => item.explicit) ?? matches[0]
    if (!selected) return []
    return [
      {
        label: selected.label,
        usedPercentage: selected.usedPercentage,
        ...(selected.resetsAt && { resetsAt: selected.resetsAt }),
      },
    ]
  })
  if (!windows.length) return
  return { providerID: "claude-code", windows, checkedAt: new Date().toISOString() }
}

/**
 * Re-read quota for every CLI that reports it. Callers hit this on a timer and
 * whenever the usage panel opens, so the work is guarded twice: this debounce
 * collapses bursts, and each provider's own TTL decides whether its CLI is
 * actually worth spawning. `force` is the panel's refresh key and skips both.
 */
export async function refreshCliAgentUsage(force = false) {
  if (usageRefresh) {
    if (!force || usageRefreshForced) return usageRefresh
    await usageRefresh
    return refreshCliAgentUsage(true)
  }
  if (!force && Date.now() - usageRefreshAt < 60_000) return readCliAgentUsage()
  usageRefreshAt = Date.now()
  usageRefreshForced = force
  usageRefresh = (async () => {
    const claude = cliAgentExecutable("claude-code")
    const antigravity = cliAgentExecutable("antigravity-cli")
    // Refresh every CLI that can report quota, not just Claude — otherwise the
    // usage panel permanently reads "No supported quota API" for the others,
    // because nothing ever populates their entry.
    await Promise.all([
      claude ? refreshClaudeQuota(claude, force).catch(() => {}) : undefined,
      antigravity
        ? refreshAntigravityQuota(antigravity, process.cwd(), force).catch((error) =>
            log.warn("antigravity quota refresh failed", {
              error: error instanceof Error ? error.message : error,
            }),
          )
        : undefined,
    ])
    return readCliAgentUsage()
  })().finally(() => {
    usageRefresh = undefined
    usageRefreshForced = false
  })
  return usageRefresh
}

/** Start a slow native quota refresh without making an HTTP request or dialog
 * wait for providers such as Antigravity. The existing single-flight guard
 * keeps repeated UI polling from spawning duplicate CLIs. */
export function startCliAgentUsageRefresh(force = false) {
  void refreshCliAgentUsage(force).catch((error) =>
    log.warn("background CLI usage refresh failed", { error: error instanceof Error ? error.message : error }),
  )
}

export function isCliAgentUsageRefreshing() {
  return Boolean(usageRefresh)
}

export function cliAgentQuotaStatuses(quotas: readonly CliAgentQuota[]): CliAgentQuotaStatus[] {
  return CLI_QUOTA_PROVIDERS.map((providerID) => ({
    providerID,
    label: providerID === "codex" ? "Codex" : providerName(providerID),
    available: quotas.some((quota) => quota.providerID === providerID),
    reason: quotas.some((quota) => quota.providerID === providerID) ? "Supported quota data" : "No supported quota API",
  }))
}

/** AGY exposes quota only behind an interactive slash command that costs ~25s
 * to reach, so refresh it only from the explicit usage flow. */
const ANTIGRAVITY_QUOTA_TTL_MS = 30 * 60 * 1000

/** Quota already re-read recently enough that asking the CLI again would only
 * cost time. `force` (the usage panel's refresh key) bypasses this. */
async function isFresh(providerID: CliAgentProviderID, ttlMs: number) {
  const current = (await readCliAgentUsage()).find((item) => item.providerID === providerID)
  if (!current?.checkedAt) return false
  const age = Date.now() - Date.parse(current.checkedAt)
  return Number.isFinite(age) && age >= 0 && age < ttlMs
}

async function refreshAntigravityQuota(executable: string, cwd: string, force = false) {
  if (!force && (await isFresh("antigravity-cli", ANTIGRAVITY_QUOTA_TTL_MS))) return
  const panel = await captureAntigravityUsage({ executable, cwd, env: await antigravityEnvironment() }).catch(
    () => undefined,
  )
  if (!panel) return
  const quota = antigravityQuotaFrom(panel)
  if (!quota) return
  usageWrite = usageWrite
    .catch(() => {})
    .then(async () => {
      const usage = (await readCliAgentUsage()).filter((item) => item.providerID !== quota.providerID)
      await Bun.write(path.join(Global.Path.data, "cli-agent-usage.json"), JSON.stringify([...usage, quota], null, 2))
    })
  await usageWrite
}

/** Stable id so quota checks reuse a single throwaway conversation. */
const CLAUDE_QUOTA_SESSION_ID = deterministicCliSessionID("codegoblin:quota-probe")

/** Cheaper than AGY's scrape but still a CLI spawn, so it gets a TTL too —
 * the usage panel and footer both refresh on a timer. */
const CLAUDE_QUOTA_TTL_MS = 10 * 60 * 1000

async function refreshClaudeQuota(executable: string, force = false) {
  if (!force && (await isFresh("claude-code", CLAUDE_QUOTA_TTL_MS))) return
  // Reuse one fixed session id for every quota check. Without it each check
  // starts a brand-new conversation that then clutters the user's `/resume`
  // picker with untitled "/usage" entries.
  // The fixed id only works as `--session-id` once. Every later check has to
  // resume that same conversation, or Claude exits 1 with "Session ID ... is
  // already in use" and the quota silently stops updating.
  let value: unknown
  let failure = "no output"
  for (const session of [
    ["--resume", CLAUDE_QUOTA_SESSION_ID],
    ["--session-id", CLAUDE_QUOTA_SESSION_ID],
  ]) {
    const result = await claudeQuotaProbe(executable, session)
    if (result.ok) {
      value = result.value
      break
    }
    failure = result.detail
  }
  const quota = value === undefined ? undefined : parseClaudeQuota(value)
  if (!quota) {
    // Swallowing this is how a probe that had been failing for a day went
    // unnoticed while the footer kept showing its last successful reading.
    log.warn("claude quota probe failed", { detail: failure })
    return
  }
  usageWrite = usageWrite
    .catch(() => {})
    .then(async () => {
      const usage = (await readCliAgentUsage()).filter((item) => item.providerID !== quota.providerID)
      await Bun.write(path.join(Global.Path.data, "cli-agent-usage.json"), JSON.stringify([...usage, quota], null, 2))
    })
  await usageWrite
}

/** One `claude --print /usage` attempt, reporting why it failed rather than
 * collapsing every failure into "no quota". */
async function claudeQuotaProbe(executable: string, session: string[]) {
  const proc = Bun.spawn(
    [...cliAgentBaseCommand("claude-code", executable), "--print", "--output-format", "json", ...session, "/usage"],
    {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: process.platform === "win32",
    },
  )
  const timeout = setTimeout(() => stopCliAgentProcess(proc), 10_000)
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    limitedText(proc.stdout, MAX_CLI_STDERR).catch((error) => {
      stopCliAgentProcess(proc)
      return error instanceof Error ? error : new Error(String(error))
    }),
    limitedText(proc.stderr, MAX_CLI_STDERR).catch((error) => {
      stopCliAgentProcess(proc)
      return error instanceof Error ? error : new Error(String(error))
    }),
  ])
  clearTimeout(timeout)
  if (stdout instanceof Error) return { ok: false as const, detail: stdout.message }
  if (stderr instanceof Error) return { ok: false as const, detail: stderr.message }
  const value = Option.getOrUndefined(decodeJson(stdout))
  if (exitCode === 0 && value !== undefined) return { ok: true as const, value }
  return { ok: false as const, detail: stderr.trim().slice(0, 300) || `exited with code ${exitCode}` }
}

function stopCliAgentProcess(proc: { pid: number; exitCode?: number | null; kill(): void }) {
  // Never target a PID after Bun has observed the owned process exit. Besides
  // being unnecessary, a stale PID could already have been reused by Windows.
  if (proc.exitCode !== undefined && proc.exitCode !== null) return
  if (process.platform !== "win32") {
    proc.kill()
    return
  }
  void Bun.spawn([Process.windowsSystem32("taskkill.exe"), "/pid", String(proc.pid), "/T", "/F"], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
    windowsHide: true,
  })
    .exited.then((code) => {
      if (code !== 0) proc.kill()
    })
    .catch(() => proc.kill())
}

function cliFailureMessage(providerID: CliAgentProviderID, stderr: string, exitCode: number) {
  const login =
    providerID === "claude-code" ? "claude auth login" : providerID === "cursor-agent" ? "cursor-agent login" : "agy"
  const detail = stderr ? `\n\n${stderr}` : ""
  return `${providerName(providerID)} exited with code ${exitCode}. Run '${login}' in this terminal and retry.${detail}`
}

function missingExecutableMessage(providerID: CliAgentProviderID) {
  const command = providerID === "claude-code" ? "claude" : providerID === "cursor-agent" ? "cursor-agent" : "agy"
  const login =
    providerID === "claude-code" ? "claude auth login" : providerID === "cursor-agent" ? "cursor-agent login" : "agy"
  return `${providerName(providerID)} is not installed or is not on PATH. Install the official ${command} CLI, run '${login}', then retry.`
}

function providerName(providerID: CliAgentProviderID) {
  if (providerID === "claude-code") return "Claude Code CLI"
  if (providerID === "cursor-agent") return "Cursor Agent CLI"
  return "Antigravity CLI"
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : undefined
}

function numberValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}
