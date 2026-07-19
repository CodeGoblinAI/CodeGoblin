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

export const CLI_AGENT_PROVIDERS = ["claude-code", "cursor-agent"] as const
export type CliAgentProviderID = (typeof CLI_AGENT_PROVIDERS)[number]

type BridgeOptions = {
  sessionID?: string
  directory?: string
  permissionMode?: "agent" | "plan"
  executable?: string
}

type BridgeSessions = Partial<Record<CliAgentProviderID, Record<string, string>>>

type ParsedEvent = {
  sessionID?: string
  text?: string
  reasoning?: string
  result?: string
  usage?: LanguageModelV3Usage
  error?: string
}

const EMPTY_USAGE: LanguageModelV3Usage = {
  inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: undefined, text: undefined, reasoning: undefined },
}

let sessionWrite = Promise.resolve()

export function cliAgentProviderInfos(): Info[] {
  return [
    providerInfo("claude-code", "Claude Code (local CLI)", [
      model("claude-code", "default", "Claude Code default", "claude"),
      model("claude-code", "fable", "Claude Fable", "claude"),
      model("claude-code", "opus", "Claude Opus", "claude"),
      model("claude-code", "sonnet", "Claude Sonnet", "claude"),
      model("claude-code", "haiku", "Claude Haiku", "claude"),
    ]),
    providerInfo("cursor-agent", "Cursor Agent (local CLI)", [
      model("cursor-agent", "default", "Cursor Agent default", "cursor"),
    ]),
  ]
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
      const executable = bridge.executable || executablePath(providerID)
      if (!executable) throw new Error(missingExecutableMessage(providerID))

      const sessions = await readSessions()
      const externalSessionID = sessions[providerID]?.[sessionID]
      const prompt = promptText(input, !externalSessionID)
      const command = buildCliAgentCommand({
        providerID,
        executable,
        modelID,
        externalSessionID,
        sessionID,
        permissionMode: bridge.permissionMode ?? "agent",
      })
      const proc = Bun.spawn(command, {
        cwd: bridge.directory || process.cwd(),
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
                await rememberSession(providerID, sessionID, event.sessionID)
              }
              if (event.reasoning) emitReasoning(event.reasoning)
              if (event.text) emitText(event.text)
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
              if (!discoveredSessionID && providerID === "claude-code") {
                discoveredSessionID = deterministicCliSessionID(sessionID)
                await rememberSession(providerID, sessionID, discoveredSessionID)
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
              controller.error(error)
            } finally {
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

function model(provider: CliAgentProviderID, id: string, name: string, family: string): Model {
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
    variants: {},
  }
}

function executablePath(providerID: CliAgentProviderID) {
  const override = process.env[providerID === "claude-code" ? "CODEGOBLIN_CLAUDE_CLI" : "CODEGOBLIN_CURSOR_CLI"]
  return override || Bun.which(providerID === "claude-code" ? "claude" : "cursor-agent")
}

export function buildCliAgentCommand(input: {
  providerID: CliAgentProviderID
  executable: string
  modelID: string
  externalSessionID?: string
  sessionID: string
  permissionMode: "agent" | "plan"
}) {
  if (input.providerID === "claude-code") {
    const external = input.externalSessionID ?? deterministicCliSessionID(input.sessionID)
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
      ...(input.modelID === "default" ? [] : ["--model", input.modelID]),
      ...(input.externalSessionID ? ["--resume", external] : ["--session-id", external]),
    ]
  }
  return [
    input.executable,
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

export function parseCliAgentEvent(providerID: CliAgentProviderID, line: string): ParsedEvent | undefined {
  if (!line.trim()) return
  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(line) as Record<string, unknown>
  } catch {
    return { text: line }
  }

  const sessionID = stringValue(raw.session_id) ?? stringValue(raw.sessionId)
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
  const file = Bun.file(sessionFile())
  if (!(await file.exists())) return {}
  return file.json().catch(() => ({}))
}

async function rememberSession(providerID: CliAgentProviderID, sessionID: string, externalSessionID: string) {
  sessionWrite = sessionWrite
    .catch(() => {})
    .then(async () => {
      const sessions = await readSessions()
      sessions[providerID] = { ...sessions[providerID], [sessionID]: externalSessionID }
      await Bun.write(sessionFile(), JSON.stringify(sessions, null, 2))
    })
  await sessionWrite
}

function sessionFile() {
  return path.join(Global.Path.data, "cli-agent-sessions.json")
}

function cliFailureMessage(providerID: CliAgentProviderID, stderr: string, exitCode: number) {
  const login = providerID === "claude-code" ? "claude auth login" : "cursor-agent login"
  const detail = stderr ? `\n\n${stderr}` : ""
  return `${providerName(providerID)} exited with code ${exitCode}. Run '${login}' in this terminal and retry.${detail}`
}

function missingExecutableMessage(providerID: CliAgentProviderID) {
  const command = providerID === "claude-code" ? "claude" : "cursor-agent"
  return `${providerName(providerID)} is not installed or is not on PATH. Install the official ${command} CLI, run '${command} auth login', then retry.`
}

function providerName(providerID: CliAgentProviderID) {
  return providerID === "claude-code" ? "Claude Code CLI" : "Cursor Agent CLI"
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
