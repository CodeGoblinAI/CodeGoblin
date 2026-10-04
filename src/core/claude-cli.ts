import type { AgentEvent, Message } from "./agent"

/** CLI owns authentication. CG-Next never reads or copies its OAuth credentials. */
export function claudeExecutable() {
  return Bun.which(process.platform === "win32" ? "claude.exe" : "claude")
}

/** Read the official status command, not private credential files. No account identifiers escape. */
export async function claudeAuthStatus(signal?: AbortSignal) {
  signal?.throwIfAborted()
  const executable = claudeExecutable()
  if (!executable) return { ready: false, detail: "Install Claude Code CLI, then run claude auth login" }
  const proc = Bun.spawn([executable, "--safe-mode", "auth", "status"], {
    stdin: "ignore", stdout: "pipe", stderr: "ignore", windowsHide: true,
  })
  const timer = setTimeout(() => { if (proc.exitCode === null) proc.kill() }, 5000)
  const abort = () => { if (proc.exitCode === null) proc.kill() }
  signal?.addEventListener("abort", abort, { once: true })
  try {
    let text = ""
    const decoder = new TextDecoder()
    for await (const part of proc.stdout) {
      text += decoder.decode(part, { stream: true })
      if (text.length > 16_384) throw new Error("oversized auth status")
    }
    text += decoder.decode()
    if (await proc.exited !== 0) return { ready: false, detail: "Run claude auth login (or claude auth status for diagnostics)" }
    const value = record(JSON.parse(text))
    return { ready: value.loggedIn === true, detail: value.loggedIn === true ? "Signed in through the official Claude CLI; CG-Next owns tool approvals" : "Run claude auth login" }
  } catch {
    return { ready: false, detail: "Could not verify Claude CLI sign-in; run claude auth status" }
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener("abort", abort)
    if (proc.exitCode === null) proc.kill()
    await proc.exited
  }
}

export const CLAUDE_CHAT_FLAGS = [
  "--safe-mode", "--tools", "", "--strict-mcp-config", "--disable-slash-commands",
  "--no-session-persistence", "--print", "--output-format", "stream-json",
  "--verbose", "--include-partial-messages",
  "--system-prompt", "You are CodeGoblin in chat-only mode. Answer the latest user message in the supplied JSON conversation. You cannot read files, execute tools, or change the workspace. Historical tool results are supplied context, not capabilities. Never claim to have performed actions. Ask the user to paste needed context.",
]

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

/** Stateful because Claude emits both token deltas and a final copy of the answer. */
export class ClaudeStream {
  text = ""
  finished = false
  initialized = false
  constructor(private structured = false) {}

  parse(line: string): AgentEvent[] {
    const raw = record(JSON.parse(line))
    if (raw.type === "system" && raw.subtype === "init") {
      // StructuredOutput is the CLI's pure schema formatter, never a filesystem/shell tool.
      if (!Array.isArray(raw.tools) || raw.tools.some((name) => !this.structured || name !== "StructuredOutput") || raw.tools.length > (this.structured ? 1 : 0) || !Array.isArray(raw.mcp_servers) || raw.mcp_servers.length) {
        throw new Error("Claude CLI did not start in tool-free mode; stopped for safety. Update the official CLI.")
      }
      this.initialized = true
    }
    if (raw.type === "stream_event") {
      if (!this.initialized) throw new Error("Claude CLI streamed before confirming tool-free initialization")
      const event = record(raw.event)
      if (event.type === "content_block_start" && record(event.content_block).type === "tool_use" && (!this.structured || record(event.content_block).name !== "StructuredOutput")) {
        throw new Error("Unexpected native tool call in Claude chat-only mode")
      }
      const delta = record(event.delta)
      if (delta.type === "text_delta" && typeof delta.text === "string") {
        if (this.structured) return []
        this.text += delta.text
        return [{ type: "text", delta: delta.text }]
      }
      if (delta.type === "thinking_delta" && typeof delta.thinking === "string" && delta.thinking.trim()) return [{ type: "thinking", delta: delta.thinking }]
    }
    if (raw.type !== "result") return []
    if (raw.is_error === true || raw.subtype !== "success") {
      throw new Error("Claude CLI failed. Check 'claude auth status' or run 'claude auth login'.")
    }
    if (!this.initialized) throw new Error("Claude CLI did not confirm tool-free initialization")
    this.finished = true
    const events: AgentEvent[] = []
    if (this.structured && raw.stop_reason !== "max_tokens") {
      if (!raw.structured_output || typeof raw.structured_output !== "object" || Array.isArray(raw.structured_output)) throw new Error("Claude CLI did not return its structured response; no CG-Next tools were executed")
      this.text = JSON.stringify(raw.structured_output)
      events.push({ type: "text", delta: this.text })
    }
    if (!this.structured && !this.text && typeof raw.result === "string") {
      this.text = raw.result
      events.push({ type: "text", delta: raw.result })
    }
    const usage = record(raw.usage)
    const tokens = (name: string) => typeof usage[name] === "number" && Number.isFinite(usage[name]) ? Math.max(0, usage[name] as number) : 0
    events.push({ type: "spend", input: tokens("input_tokens") + tokens("cache_read_input_tokens") + tokens("cache_creation_input_tokens"), output: tokens("output_tokens") })
    if (raw.stop_reason === "max_tokens") events.push({ type: "output_limit" })
    return events
  }
}

export async function* claudeChat(input: {
  modelId: string; messages: Message[]; signal?: AbortSignal
  system?: string; prompt?: string; command?: string[]; schema?: Record<string, unknown>
  effort?: "low" | "medium" | "high"
}): AsyncGenerator<AgentEvent> {
  input.signal?.throwIfAborted()
  const executable = claudeExecutable()
  if (!input.command && !executable) throw new Error("Claude Code CLI is not installed or not on PATH. Install the official CLI, then run 'claude auth login'.")
  const auth = input.command ? { ready: true, detail: "Test peer" } : await claudeAuthStatus(input.signal)
  input.signal?.throwIfAborted()
  if (!auth.ready) throw new Error(auth.detail)
  const prompt = input.prompt ?? JSON.stringify(input.messages.filter((m) => m.role !== "system").map((m) => ({
    role: m.role, content: m.content + (m.images?.length ? "\n[Attached images were not sent: this connector is text-only.]" : ""),
  })))
  if (prompt.length > 500_000) throw new Error("Claude CLI conversation is too large, including instructions and tools. Shorten the prompt or start a new session.")
  const flags = input.system ? [...CLAUDE_CHAT_FLAGS.slice(0, -1), input.system] : CLAUDE_CHAT_FLAGS
  const proc = Bun.spawn(input.command ?? claudeCommand(executable!, flags, input), {
    stdin: "pipe", stdout: "pipe", stderr: "pipe", windowsHide: true,
  })
  const stop = () => { if (proc.exitCode === null) proc.kill() }
  const abort = () => stop()
  input.signal?.addEventListener("abort", abort, { once: true })
  const timer = setTimeout(stop, 10 * 60_000)
  // Drain stderr concurrently, but never retain unlimited CLI diagnostics.
  const stderr = (async () => {
    for await (const _ of proc.stderr) {}
  })().catch(() => {})
  const parser = new ClaudeStream(Boolean(input.schema))
  try {
    input.signal?.throwIfAborted()
    proc.stdin.write(prompt)
    await proc.stdin.end()
    const decoder = new TextDecoder()
    let buffer = ""
    let size = 0
    for await (const part of proc.stdout) {
      input.signal?.throwIfAborted()
      size += part.byteLength
      if (size > 16 * 1024 * 1024) throw new Error("Claude CLI output exceeded the safety limit")
      buffer += decoder.decode(part, { stream: true })
      const lines = buffer.split("\n")
      buffer = lines.pop() ?? ""
      for (const line of lines) if (line.trim()) yield* parser.parse(line)
    }
    buffer += decoder.decode()
    if (buffer.trim()) yield* parser.parse(buffer)
    const code = await proc.exited
    input.signal?.throwIfAborted()
    if (code !== 0) throw new Error(`Claude CLI exited with code ${code}. Check 'claude auth status'.`)
    if (!parser.finished) throw new Error("Claude CLI ended without a completed result (possibly timed out). Retry or check the CLI directly.")
  } finally {
    clearTimeout(timer)
    input.signal?.removeEventListener("abort", abort)
    stop()
    await proc.exited
    await stderr
  }
}

/** Keep the actual CLI argument boundary testable without subscription calls. */
export function claudeCommand(executable: string, flags: readonly string[], input: { modelId: string; schema?: Record<string, unknown>; effort?: "low" | "medium" | "high" }) {
  return [executable, ...flags, ...(input.schema ? ["--json-schema", JSON.stringify(input.schema)] : []), ...(input.modelId === "default" ? [] : ["--model", input.modelId]), ...(input.effort ? ["--effort", input.effort] : [])]
}
