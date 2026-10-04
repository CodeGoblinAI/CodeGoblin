import type { AgentOptions, SDKMessage } from "@cursor/sdk"

/** Every SDK turn is tool-free. CG-Next is the only executor. */
export function cursorOptions(apiKey: string, modelId: string, cwd: string): AgentOptions {
  return {
    apiKey, model: { id: modelId === "default" ? "auto" : modelId },
    tools: [], disallowedTools: ["mcp", "task"], mcpServers: {}, agents: {},
    local: { cwd, settingSources: [], enableAgentRetries: false },
  }
}

/** Defense in depth if an SDK/server update violates the explicit allowlist. */
export function checkCursorMessage(message: SDKMessage) {
  if (message.type === "tool_call" || message.type === "task" || message.type === "request" ||
    (message.type === "system" && message.tools?.length) ||
    (message.type === "assistant" && message.message.content.some((block) => block.type !== "text"))) {
    throw new Error("Cursor requested a native capability; inference stopped for safety")
  }
}

export function cursorLoginUrl(url: string) {
  const target = new URL(url)
  if (target.protocol !== "https:" || target.hostname !== "cursor.com" || target.port || target.username || target.password || target.pathname !== "/loginDeepControl" || target.searchParams.get("redirectTarget") !== "sdk") throw new Error("Untrusted Cursor sign-in URL")
  return target.href
}

/** No inherited key, endpoint override, MCP credential or CLI auth environment. */
export function cursorEnvironment(env: NodeJS.ProcessEnv) {
  const allowed = new Set(["PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "HOME", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "LANG", "LC_ALL"])
  return Object.fromEntries(Object.entries(env).filter(([name, value]) => allowed.has(name.toUpperCase()) && value !== undefined))
}
