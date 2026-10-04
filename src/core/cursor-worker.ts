import fs from "node:fs/promises"
import path from "node:path"
import { Agent, Cursor, FileCredentialStore, JsonlLocalAgentStore, type SdkCredentialStore } from "@cursor/sdk"
import { cursorOptions, checkCursorMessage, cursorLoginUrl } from "./cursor-policy"

// Dedicated process: SDK diagnostics never enter CG-Next's logs or transcript.
const controller = new AbortController()
const emit = (packet: unknown) => process.stdout.write(JSON.stringify(packet) + "\n")
let started = false
let size = 0

async function run(input: { op: string; mode: string; authPath: string; storePath: string; workspaceRoot: string; apiKey?: string; modelId?: string; prompt?: string; system?: string }) {
  const file = new FileCredentialStore(input.authPath)
  const store: SdkCredentialStore = {
    load: () => file.load(),
    save: async (credentials) => { controller.signal.throwIfAborted(); await file.save(credentials) },
    // CG-Next does not call SDK logout: deleting files must follow our Recycle Bin policy.
    clear: async () => { throw new Error("Credential removal is not supported by this worker") },
  }
  if (input.op === "login") {
    await Cursor.auth.login({ backendUrl: "https://api2.cursor.sh", websiteUrl: "https://cursor.com", openBrowser: false,
      onLoginUrl: (url) => emit({ type: "url", url: cursorLoginUrl(url) }), store,
      apiKeyName: "CG-Next user-plan access", signal: controller.signal })
    controller.signal.throwIfAborted()
    emit({ type: "done" })
    return
  }
  // Always pass a key explicitly. Never fall back to the CLI, ambient env or default SDK store.
  const stored = input.mode === "cursor" ? await store.load() : undefined
  const key = input.mode === "cursor-api" ? input.apiKey : stored?.backendUrl === "https://api2.cursor.sh" &&
    (stored.apiKeyExpiresAtMs === undefined || stored.apiKeyExpiresAtMs > Date.now()) ? stored.apiKey : undefined
  if (input.op === "status") { emit({ type: "status", ready: Boolean(key) }); emit({ type: "done" }); return }
  if (!key) { emit({ type: "error", code: "signed-out" }); return }
  if (input.op === "models") {
    const models = await Cursor.models.list({ apiKey: key })
    emit({ type: "models", models: models.slice(0, 200).map((model) => ({ id: model.id, label: model.displayName })) })
    emit({ type: "done" })
    return
  }
  if (input.op !== "completion" || !input.prompt || !input.system || !input.modelId) throw new Error("Invalid operation")
  await fs.mkdir(input.workspaceRoot, { recursive: true })
  // Never point the SDK at the user's project, even with ambient settings disabled.
  const cwd = await fs.mkdtemp(path.join(input.workspaceRoot, "turn-"))
  const options = cursorOptions(key, input.modelId, cwd)
  options.local!.store = new JsonlLocalAgentStore(input.storePath)
  const agent = await Agent.create(options)
  try {
    controller.signal.throwIfAborted()
    // System-prompt replacement is account-gated; the tool-free policy is not.
    const turn = await agent.send(input.system + "\n\n" + input.prompt)
    const cancel = () => { void turn.cancel().catch(() => {}) }
    controller.signal.addEventListener("abort", cancel, { once: true })
    if (controller.signal.aborted) cancel()
    try {
      let text = ""
      for await (const message of turn.stream()) {
        controller.signal.throwIfAborted()
        checkCursorMessage(message)
        if (message.type === "thinking") emit({ type: "thinking", delta: message.text })
        if (message.type === "assistant") {
          text += message.message.content.flatMap((block) => block.type === "text" ? [block.text] : []).join("")
          if (text.length > 4_000_000) throw new Error("Output limit")
        }
      }
      const result = await turn.wait()
      controller.signal.throwIfAborted()
      if (result.status !== "finished") throw new Error("Incomplete response")
      emit({ type: "text", delta: text || result.result || "" })
      if (result.usage) emit({ type: "spend", input: result.usage.inputTokens + result.usage.cacheReadTokens + result.usage.cacheWriteTokens, output: result.usage.outputTokens })
      emit({ type: "done" })
    } finally {
      controller.signal.removeEventListener("abort", cancel)
      if (turn.status === "running") await turn.cancel().catch(() => {})
      await turn.wait().catch(() => {})
    }
  } finally { await agent[Symbol.asyncDispose]() }
}

let buffer = ""
const decoder = new TextDecoder()
for await (const part of Bun.stdin.stream()) {
  size += part.byteLength
  if (size > 2_100_000) { controller.abort(); process.exit(1) }
  buffer += decoder.decode(part, { stream: true })
  const lines = buffer.split("\n")
  buffer = lines.pop() || ""
  for (const line of lines) {
    if (!line) continue
    if (started) { if (line === '{"cancel":true}') controller.abort(); continue }
    started = true
    void Promise.resolve().then(() => run(JSON.parse(line))).catch(() => emit({ type: "error", code: controller.signal.aborted ? "cancelled" : "unavailable" })).finally(() => {
      // Flush protocol output before terminating any SDK background activity.
      process.stdout.write("", () => process.exit(0))
    })
  }
}
controller.abort()
