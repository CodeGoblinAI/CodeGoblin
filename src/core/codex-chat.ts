import type { AgentEvent } from "./agent"
import { CodexRpc, object } from "./codex-rpc"
import { PROVIDERS } from "./providers"

/** No native execution: CG-Next's agent loop is the only tool owner. */
export const CODEX_INFERENCE_CONFIG: Record<string, unknown> = {
  "features.shell_tool": false, "features.unified_exec": false,
  "features.code_mode": false, "features.code_mode_host": false,
  "features.apps": false, "features.plugins": false, "features.hooks": false,
  "features.multi_agent": false, "agents.enabled": false,
  "features.computer_use": false, "features.browser_use": false,
  "features.browser_use_external": false, "features.in_app_browser": false,
  "features.image_generation": false, "features.workspace_dependencies": false,
  "features.memories": false, "features.skill_search": false,
  "features.skill_mcp_dependency_install": false,
  "tools.view_image": false, "web_search": "disabled", "project_doc_max_bytes": 0,
}

export async function codexAuthStatus(start = () => CodexRpc.start()) {
  let rpc: CodexRpc | undefined
  try {
    rpc = await start()
    const account = object(object(await rpc.call("account/read", { refreshToken: false })).account)
    const ready = account.type === "chatgpt" || account.type === "apiKey"
    if (ready) {
      const listed = object(await rpc.call("model/list", { limit: 100 }))
      const models = Array.isArray(listed.data) ? listed.data.flatMap((entry) => {
        const model = object(entry)
        if (typeof model.model !== "string" || !/^[A-Za-z0-9._-]{1,100}$/.test(model.model)) return []
        const effort = Array.isArray(model.supportedReasoningEfforts) && model.supportedReasoningEfforts.some((entry) => ["low", "medium", "high"].includes(String(object(entry).reasoningEffort)))
        return [{ id: model.model, label: model.model, contextWindow: 0, effort, reasoning: effort }]
      }) : []
      if (models.length && PROVIDERS.codex) {
        const selected = Array.isArray(listed.data) ? object(listed.data.find((entry) => object(entry).isDefault === true)).model : undefined
        const effort = models.find((entry) => entry.id === selected)?.effort ?? false
        PROVIDERS.codex.models = [{ id: "default", label: "official default", contextWindow: 0, effort, reasoning: effort }, ...models]
      }
    }
    return { ready, detail: ready ? "Official Codex CLI authentication; CG-Next owns tool approvals" : "Run /login codex or codex login" }
  } catch { return { ready: false, detail: "Install/update the official Codex CLI and run codex login" } }
  finally { await rpc?.close() }
}

/** One ephemeral, tool-free inference turn. No official conversation is resumed. */
export async function* codexChat(input: {
  modelId: string; prompt: string; system: string; signal?: AbortSignal
  effort?: "low" | "medium" | "high"
  schema?: Record<string, unknown>
  start?: () => Promise<CodexRpc>
}): AsyncGenerator<Extract<AgentEvent, { type: "text" | "thinking" | "spend" }>> {
  input.signal?.throwIfAborted()
  if (input.prompt.length > 500_000) throw new Error("Codex CLI conversation is too large, including instructions and tools. Shorten the prompt or start a new session.")
  const executable = Bun.which(process.platform === "win32" ? "codex.exe" : "codex")
  if (!input.start && !executable) throw new Error("Install the official Codex CLI and run codex login")
  // Disable startup hooks before any thread is created. Never alter the user's config.
  const command = [executable!, "app-server", "--stdio", ...Object.entries(CODEX_INFERENCE_CONFIG).flatMap(([key, value]) => ["-c", key + "=" + JSON.stringify(value)])]
  const rpc = await (input.start ? input.start() : CodexRpc.start(command, 10 * 60_000, true))
  const queue: { method: string; params: unknown }[] = []
  let wake: (() => void) | undefined
  const unsubscribe = rpc.onNotification((method, params) => {
    queue.push({ method, params })
    if (queue.length > 10_000) { void rpc.close(); return }
    wake?.()
  })
  const unclosed = rpc.onClosed(() => wake?.())
  const abort = () => { void rpc.close() }
  input.signal?.addEventListener("abort", abort, { once: true })
  try {
    input.signal?.throwIfAborted()
    // The leading product token is the originator: "codex_cli_rs" or "Codex Desktop"
    // on older CLIs, the client's own name ("cg_next") from 0.164.0 on. Its version
    // is the CLI's either way; the client's own version is the parenthesised tail.
    const version = /^\s*(?:codex_cli_rs|codex(?: Desktop)?|cg_next)\/(\d+)\.(\d+)\.(\d+)/i.exec(rpc.userAgent)
    if (!version || (Number(version[1]) === 0 && (Number(version[2]) < 153 || (Number(version[2]) === 153 && Number(version[3]) < 3)))) throw new Error("Codex inference requires CLI 0.153.3 or later with environment access controls; no compatibility fallback is used")
    const account = object(object(await rpc.call("account/read", { refreshToken: false })).account)
    if (account.type !== "chatgpt" && account.type !== "apiKey") throw new Error("Run /login codex or codex login before selecting Codex CLI")
    // Explicitly disable every configured standalone MCP server, not just an empty-table merge.
    const config = object(object(await rpc.call("config/read", { includeLayers: false })).config)
    const mcp = Object.keys(object(config.mcp_servers)).map((name) => ["mcp_servers." + name + ".enabled", false])
    const listed = input.modelId === "default" ? object(await rpc.call("model/list", { limit: 100 })) : undefined
    const model = listed && Array.isArray(listed.data) ? object(listed.data.find((entry) => object(entry).isDefault === true)).model : input.modelId
    if (typeof model !== "string" || !model) throw new Error("Codex did not report an available default model")
    const started = object(await rpc.call("thread/start", {
      model,
      modelProvider: "openai", ephemeral: true, approvalPolicy: "never", sandbox: "read-only",
      // Required by the installed 0.153.3 schema: empty disables environment access.
      // This is independent of the read-only sandbox and of refusing approval requests.
      environments: [], runtimeWorkspaceRoots: [], selectedCapabilityRoots: [],
      baseInstructions: input.system, developerInstructions: "Use only the CG-Next JSON response protocol. Native tools are unavailable.",
      config: { ...CODEX_INFERENCE_CONFIG, ...Object.fromEntries(mcp) },
    }))
    const threadId = object(started.thread).id
    if (typeof threadId !== "string" || started.approvalPolicy !== "never" || object(started.sandbox).type !== "readOnly") {
      throw new Error("Codex did not confirm the isolated inference policy; update the official CLI")
    }
    const begun = object(await rpc.call("turn/start", {
      threadId, environments: [], runtimeWorkspaceRoots: [], approvalPolicy: "never",
      input: [{ type: "text", text: input.prompt }], ...(input.effort ? { effort: input.effort } : {}),
      ...(input.schema ? { outputSchema: input.schema } : {}),
    }))
    const turnId = object(begun.turn).id
    if (typeof turnId !== "string") throw new Error("Codex returned an invalid turn")
    let inputTokens: number | undefined
    let outputTokens: number | undefined
    let streamed = false
    for (;;) {
      input.signal?.throwIfAborted()
      if (!queue.length) {
        if (rpc.closed) throw new Error("Codex inference stopped before completion (possibly timed out)")
        await new Promise<void>((resolve) => { wake = resolve })
        wake = undefined
        continue
      }
      const packet = queue.shift()!
      const params = object(packet.params)
      if (params.threadId !== threadId) continue
      if (params.turnId !== undefined && params.turnId !== turnId) continue
      if (packet.method === "item/agentMessage/delta" && typeof params.delta === "string") { streamed = true; yield { type: "text", delta: params.delta } }
      if (packet.method === "item/completed" && object(params.item).type === "agentMessage" && !streamed && typeof object(params.item).text === "string") {
        streamed = true
        yield { type: "text", delta: object(params.item).text as string }
      }
      if (packet.method === "item/reasoning/summaryTextDelta" && typeof params.delta === "string") yield { type: "thinking", delta: params.delta }
      if (packet.method === "item/started") {
        const type = object(params.item).type
        if (type !== "agentMessage" && type !== "reasoning" && type !== "userMessage") throw new Error("Codex requested an unexpected native capability; inference stopped for safety")
      }
      if (packet.method === "thread/tokenUsage/updated") {
        const total = object(object(params.tokenUsage).total)
        if (typeof total.inputTokens === "number" && Number.isSafeInteger(total.inputTokens) && total.inputTokens >= 0) inputTokens = total.inputTokens
        if (typeof total.outputTokens === "number" && Number.isSafeInteger(total.outputTokens) && total.outputTokens >= 0) outputTokens = total.outputTokens
      }
      if (packet.method !== "turn/completed") continue
      const turn = object(params.turn)
      if (turn.id !== turnId) continue
      if (turn.status !== "completed") throw new Error("Codex did not finish the response; check sign-in, quota or CLI compatibility")
      if (inputTokens !== undefined && outputTokens !== undefined) yield { type: "spend", input: inputTokens, output: outputTokens }
      return
    }
  } finally {
    unsubscribe(); unclosed()
    input.signal?.removeEventListener("abort", abort)
    await rpc.close()
  }
}
