/** Official CLI owns browser auth, credential storage and the selected shared account. */
export function cliHandoff(source: "claude" | "cursor") {
  return {
    label: source === "claude" ? "Claude CLI" : "Cursor CLI",
    command: source === "claude" ? "claude auth login --claudeai" : "agent login",
    statusCommand: source === "claude" ? "claude auth status" : "agent status",
    warning: "Run this in your own terminal to open the official sign-in flow. Completing sign-in can change the shared CLI account. CG-Next never copies passwords or tokens. Closing this dialog does not cancel a login you start externally.",
  }
}
