// Deterministic stdio peer: no network, auth files or inference.
import { createInterface } from "node:readline"
// Node's line/stdio APIs keep the Windows fixture's repeated writes deterministic.
for await (const line of createInterface({ input: process.stdin })) {
    if (!line.trim()) continue
    const input = JSON.parse(line)
    if (input.method === "initialized") continue
    if (input.method === "initialize") {
      if (process.argv[2] === "bad-init") { process.stdout.write('not JSON\n'); continue }
      process.stdout.write(JSON.stringify({ id: input.id, result: { userAgent: process.argv[2] === "old-version" ? "Codex Desktop/0.100.0" : "Codex Desktop/0.153.3" } }) + "\n")
      continue
    }
    if (input.method === "fixture/hang") continue
    if (input.method === "config/read") {
      process.stdout.write(JSON.stringify({ id: input.id, result: { config: { mcp_servers: { fixture: { enabled: true } } } } }) + "\n")
      continue
    }
    if (input.method === "model/list") {
      process.stdout.write(JSON.stringify({ id: input.id, result: { data: [{ model: "fixture-default", isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "medium" }, { reasoningEffort: "high" }] }, { model: "fixture-no-effort", supportedReasoningEfforts: [] }] } }) + "\n")
      continue
    }
    if (input.method === "thread/start") {
      if (input.params.ephemeral !== true || input.params.environments?.length !== 0 || input.params.runtimeWorkspaceRoots?.length !== 0 || input.params.config?.["mcp_servers.fixture.enabled"] !== false || input.params.config?.["features.hooks"] !== false || input.params.config?.["features.shell_tool"] !== false) throw new Error("Unsafe inference policy")
      process.stdout.write(JSON.stringify({ id: input.id, result: { thread: { id: "inference-thread" }, approvalPolicy: "never", sandbox: { type: process.argv[2] === "unsafe-policy" ? "dangerFullAccess" : "readOnly" } } }) + "\n")
      continue
    }
    if (input.method === "turn/start") {
      if (process.argv[2] === "effort-inference" && input.params.effort !== "high") throw new Error("Effort was not forwarded")
      if (input.params.environments?.length !== 0 || input.params.approvalPolicy !== "never") throw new Error("Unsafe turn policy")
      const notify = (method: string, params: unknown) => process.stdout.write(JSON.stringify({ method, params }) + "\n")
      // Events can arrive before the turn/start response. The client must retain and scope them.
      notify("item/agentMessage/delta", { threadId: "unrelated", turnId: "other", delta: "must not leak" })
      notify("item/started", { threadId: "inference-thread", turnId: "inference-turn", item: { type: process.argv[2] === "native-inference" ? "commandExecution" : "agentMessage" } })
      const params = { threadId: "inference-thread", turnId: "inference-turn" }
      if (process.argv[2] !== "fallback-inference") notify("item/agentMessage/delta", { ...params, delta: "CODEX_FIXTURE" })
      else notify("item/completed", { ...params, item: { type: "agentMessage", text: "CODEX_FIXTURE" } })
      notify("thread/tokenUsage/updated", { ...params, tokenUsage: { total: { inputTokens: 15, outputTokens: 5 } } })
      notify("thread/tokenUsage/updated", { ...params, tokenUsage: { total: { inputTokens: 15, outputTokens: 5 } } })
      if (process.argv[2] !== "hang-inference") notify("turn/completed", { threadId: "inference-thread", turn: { id: "inference-turn", status: process.argv[2] === "failed-inference" ? "failed" : "completed", error: { message: "secret-token" } } })
      process.stdout.write(JSON.stringify({ id: input.id, result: { turn: { id: "inference-turn" } } }) + "\n")
      continue
    }
    if (input.method === "account/login/start") {
      if (process.argv[2] === "early-login") process.stdout.write(JSON.stringify({ method: "account/login/completed", params: { loginId: "fixture-login", success: true } }) + "\n")
      process.stdout.write(JSON.stringify({ id: input.id, result: { type: "chatgpt", loginId: "fixture-login", authUrl: process.argv[2] === "bad-login" ? "https://example.com/secret-token" : "https://auth.openai.com/authorize?fixture=1" } }) + "\n")
      continue
    }
    if (input.method === "thread/list") {
      process.stdout.write(JSON.stringify({ id: input.id, result: { data: [
        { id: "source-1", cwd: process.cwd(), name: "Fixture transcript" },
        { id: "unrelated", cwd: process.cwd() + "/unrelated", name: "Never shown" },
      ], nextCursor: "fixture-next" } }) + "\n")
      continue
    }
    if (input.method === "thread/read") {
      process.stdout.write(JSON.stringify({ id: input.id, result: { thread: { id: "source-1", cwd: process.cwd(), name: "Fixture transcript", turns: [{ items: [
        { type: "userMessage", content: [{ type: "text", text: "Fixture hello" }] },
        { type: "agentMessage", text: "Fixture reply" },
        { type: "commandExecution", command: "must not import" },
      ] }] } } }) + "\n")
      continue
    }
    if (input.method === "fixture/error") {
      process.stdout.write(JSON.stringify({ id: input.id, error: { message: "secret-token email@example.com" } }) + "\n")
      continue
    }
    if (input.method === "fixture/request") {
      process.stdout.write(JSON.stringify({ id: "server-tool", method: "item/tool/call", params: { tool: "shell" } }) + "\n")
      continue
    }
    if (input.id === "server-tool") {
      process.stdout.write(JSON.stringify({ method: "fixture/refused", params: { refused: input.error?.code === -32601 } }) + "\n")
      continue
    }
    if (input.method === "account/read") {
      const account = process.argv[2] === "signed-out" ? null : { type: process.argv[2] === "api-key" ? "apiKey" : "chatgpt", email: "private@example.com", planType: "plus" }
      process.stdout.write(JSON.stringify({ id: input.id, result: { account, requiresOpenaiAuth: true } }) + "\n")
      continue
    }
    if (input.method === "account/rateLimits/read") {
      if (process.argv[2] === "quota-error") { process.stdout.write(JSON.stringify({ id: input.id, error: { message: "secret quota error" } }) + "\n"); continue }
      process.stdout.write(JSON.stringify({ id: input.id, result: { rateLimits: { primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 2000000000 }, secondary: null } } }) + "\n")
      continue
    }
    process.stdout.write(JSON.stringify({ id: input.id, result: input.params }) + "\n")
}
