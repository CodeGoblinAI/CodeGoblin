import path from "path"
import { Global } from "@codegoblin/core/global"
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

export const CLI_AGENT_PROVIDERS = ["claude-code", "cursor-agent", "antigravity-cli"] as const
export type CliAgentProviderID = (typeof CLI_AGENT_PROVIDERS)[number]

export function isCliAgentProvider(value: string): value is CliAgentProviderID {
  return CLI_AGENT_PROVIDERS.includes(value as CliAgentProviderID)
}

type BridgeOptions = {
  sessionID?: string
  directory?: string
  permissionMode?: "agent" | "plan"
  effort?: "low" | "medium" | "high" | "xhigh" | "max"
  executable?: string
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

export type CliAgentQuota = {
  providerID: CliAgentProviderID
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

let discoveredProviders: Promise<Info[]> | undefined

let sessionWrite = Promise.resolve()
let usageWrite = Promise.resolve()

export function cliAgentProviderInfos(input?: Partial<Record<CliAgentProviderID, DiscoveredModel[]>>): Info[] {
  return [
    providerInfo(
      "claude-code",
      "Claude Code (local CLI)",
      (input?.["claude-code"] ?? [
        { id: "default", name: "Claude account default (resolved after connection)" },
        { id: "fable", name: "Claude Fable 5 (alias)" },
        { id: "opus", name: "Claude Opus 4.8 (alias)" },
        { id: "sonnet", name: "Claude Sonnet 5 (alias)" },
        { id: "haiku", name: "Claude Haiku 4.5 (alias)" },
      ]).map((item) => model("claude-code", item.id, item.name, "claude", CLAUDE_VARIANTS)),
    ),
    providerInfo(
      "cursor-agent",
      "Cursor Agent (local CLI)",
      (input?.["cursor-agent"] ?? [{ id: "default", name: "Cursor account default" }]).map((item) =>
        model("cursor-agent", item.id, item.name, "cursor"),
      ),
    ),
    providerInfo(
      "antigravity-cli",
      "Antigravity (local CLI)",
      (input?.["antigravity-cli"] ?? [{ id: "default", name: "Antigravity account default" }]).map((item) =>
        model("antigravity-cli", item.id, item.name, "antigravity"),
      ),
    ),
  ]
}

export function discoverCliAgentProviderInfos() {
  discoveredProviders ??= Promise.all([
    discoverCursorModels(),
    discoverAntigravityModels(),
  ]).then(([cursor, antigravity]) =>
    cliAgentProviderInfos({
      ...(cursor.length && { "cursor-agent": cursor }),
      ...(antigravity.length && { "antigravity-cli": antigravity }),
    }),
  )
  return discoveredProviders
}

async function discoverCursorModels() {
  const executable = cliAgentExecutable("cursor-agent")
  if (!executable) return []
  const result = await runDiscovery([...cliAgentBaseCommand("cursor-agent", executable), "models"])
  if (!result) return []
  return parseModelLines(result)
}

async function discoverAntigravityModels() {
  const executable = cliAgentExecutable("antigravity-cli")
  if (!executable) return []
  const result = await runDiscovery([...cliAgentBaseCommand("antigravity-cli", executable), "models"])
  if (!result) return []
  return parseModelLines(result)
}

function parseModelLines(value: string) {
  return value
    .replace(/\x1b\[[0-9;]*m/g, "")
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^[>*●•-]\s*/, ""))
    .filter((line) => line && !/^(available )?models?:?$/i.test(line))
    .map((name) => ({ id: name, name }))
}

async function runDiscovery(command: string[]) {
  const proc = Bun.spawn(command, { stdin: "ignore", stdout: "pipe", stderr: "ignore" })
  const timeout = setTimeout(() => proc.kill(), 5_000)
  const [exitCode, stdout] = await Promise.all([proc.exited, new Response(proc.stdout).text()])
  clearTimeout(timeout)
  if (exitCode !== 0) return
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
      const prompt = promptText(input, !externalSessionID)
      const logFile =
        providerID === "antigravity-cli"
          ? path.join(Global.Path.data, `antigravity-${sessionID}-${crypto.randomUUID()}.log`)
          : undefined
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
      })
      const proc = Bun.spawn(command, {
        cwd: bridge.directory || (typeof remembered === "string" ? undefined : remembered?.directory) || process.cwd(),
        env: process.env,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      })
      proc.stdin.write(prompt)
      proc.stdin.end()

      const abort = () => proc.kill()
      input.abortSignal?.addEventListener("abort", abort, { once: true })

      return {
        stream: new ReadableStream<LanguageModelV3StreamPart>({
          async start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] })
            const stderrPromise = new Response(proc.stderr).text()
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
              if (providerID === "claude-code") void refreshClaudeQuota(executable).catch(() => {})
            } catch (error) {
              controller.error(error)
            } finally {
              if (logFile)
                await Bun.file(logFile)
                  .delete()
                  .catch(() => {})
              input.abortSignal?.removeEventListener("abort", abort)
            }
          },
          cancel() {
            proc.kill()
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

export function cliAgentExecutable(providerID: CliAgentProviderID) {
  const env = {
    "claude-code": "CODEGOBLIN_CLAUDE_CLI",
    "cursor-agent": "CODEGOBLIN_CURSOR_CLI",
    "antigravity-cli": "CODEGOBLIN_ANTIGRAVITY_CLI",
  }[providerID]
  const command = { "claude-code": "claude", "cursor-agent": "cursor-agent", "antigravity-cli": "agy" }[providerID]
  const executable = process.env[env] || Bun.which(command)
  if (executable) return executable
  if (providerID !== "cursor-agent" || process.platform !== "win32") return
  for (const command of ["agent", "cursor-agent"]) {
    const fromPath = Bun.which(command)
    if (fromPath) return fromPath
  }
  for (const candidate of cursorAgentCandidates()) {
    if (Bun.file(candidate).size > 0) return candidate
  }
}

export function cursorAgentCandidates(
  env: NodeJS.ProcessEnv = process.env,
  platform = process.platform,
) {
  if (platform !== "win32" || !env.LOCALAPPDATA) return []
  const root = path.join(env.LOCALAPPDATA, "cursor-agent")
  const launchers = ["cursor-agent.exe", "cursor-agent.cmd", "cursor-agent.ps1", "agent.exe", "agent.cmd", "agent.ps1"]
  return [
    ...launchers.map((launcher) => path.join(root, launcher)),
    ...launchers.map((launcher) => path.join(root, "versions", "current", launcher)),
  ]
}

export function cliAgentBaseCommand(providerID: CliAgentProviderID, executable: string) {
  if (providerID === "cursor-agent" && /(?:^|[\\/])wsl(?:\.exe)?$/i.test(executable)) {
    return [executable, "cursor-agent"]
  }
  return [executable]
}

export function cliAgentResumeCommand(
  providerID: CliAgentProviderID,
  executable: string,
  externalSessionID: string,
) {
  if (providerID === "claude-code") return [executable, "--resume", externalSessionID]
  if (providerID === "cursor-agent") return [...cliAgentBaseCommand(providerID, executable), "resume", externalSessionID]
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
}) {
  if (input.providerID === "claude-code") {
    const external = input.externalSessionID ?? input.newSessionID ?? deterministicCliSessionID(input.sessionID)
    return [
      input.executable,
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
      ...(input.externalSessionID ? ["--resume", external] : ["--session-id", external]),
    ]
  }
  if (input.providerID === "antigravity-cli") {
    return [
      ...cliAgentBaseCommand(input.providerID, input.executable),
      "--print",
      ...(input.logFile ? ["--log-file", input.logFile] : []),
      "--mode",
      input.permissionMode === "plan" ? "plan" : "accept-edits",
      ...(input.modelID === "default" ? [] : ["--model", input.modelID]),
      ...(input.externalSessionID ? ["--conversation", input.externalSessionID] : []),
    ]
  }
  return [
    ...cliAgentBaseCommand(input.providerID, input.executable),
    "--print",
    "--output-format",
    "stream-json",
    ...(input.modelID === "default" ? [] : ["--model", input.modelID]),
    ...(input.externalSessionID ? [`--resume=${input.externalSessionID}`] : []),
  ]
}

function promptText(input: LanguageModelV3CallOptions, full: boolean) {
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
  return rendered.join("\n\n")
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

function parseAntigravityEvent(raw: Record<string, unknown>, sessionID?: string): ParsedEvent | undefined {
  const source = stringValue(raw.source)
  const type = stringValue(raw.type)?.toUpperCase()
  if (source === "USER_EXPLICIT" || type === "USER_INPUT") {
    return { sessionID, role: "user", text: stringValue(raw.content) }
  }
  if (source !== "MODEL" && type !== "ASSISTANT" && type !== "RESPONSE" && type !== "PLANNER_RESPONSE") {
    return { sessionID }
  }
  return {
    sessionID,
    role: "assistant",
    text: stringValue(raw.content) ?? contentText(raw.message),
    reasoning: stringValue(raw.thinking) ?? stringValue(raw.reasoning),
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
  return {
    inputTokens: {
      total: input,
      noCache: input !== undefined && cacheRead !== undefined ? Math.max(0, input - cacheRead) : input,
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
  const windows = result.split(/\r?\n/).flatMap((line) => {
    const match = /^Current (5[- ]hour|week \(all models\)):\s*(\d+(?:\.\d+)?)% used(?:\s*·\s*resets (.+))?/i.exec(
      line.trim(),
    )
    if (!match) return []
    const label = match[1].toLowerCase().startsWith("5") ? "5h" : "week"
    return [{ label, usedPercentage: Number(match[2]), ...(match[3] && { resetsAt: match[3] }) }]
  })
  if (!windows.length) return
  return { providerID: "claude-code", windows, checkedAt: new Date().toISOString() }
}

async function refreshClaudeQuota(executable: string) {
  const proc = Bun.spawn(
    [...cliAgentBaseCommand("claude-code", executable), "--print", "--output-format", "json", "/usage"],
    {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    },
  )
  const [exitCode, value] = await Promise.all([proc.exited, new Response(proc.stdout).json().catch(() => undefined)])
  if (exitCode !== 0) return
  const quota = parseClaudeQuota(value)
  if (!quota) return
  usageWrite = usageWrite
    .catch(() => {})
    .then(async () => {
      const usage = (await readCliAgentUsage()).filter((item) => item.providerID !== quota.providerID)
      await Bun.write(path.join(Global.Path.data, "cli-agent-usage.json"), JSON.stringify([...usage, quota], null, 2))
    })
  await usageWrite
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
