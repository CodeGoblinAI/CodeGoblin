// Zen interprets the opencode token as an upstream compatibility version, not
// the fork's release version. Keep CodeGoblin's identity explicit alongside it.
const COMPATIBILITY_VERSION = "1.18.0"

export function headers(input: { providerID: string; version: string; sessionID: string; parentSessionID?: string }): Record<string, string> {
  if (input.providerID !== "opencode") return {}
  return {
    "User-Agent": `opencode/${COMPATIBILITY_VERSION} codegoblin/${input.version}`,
    "x-codegoblin-version": input.version,
    "x-opencode-session-id": input.sessionID,
    ...(input.parentSessionID ? { "x-opencode-parent-session-id": input.parentSessionID } : {}),
  }
}

export * as Zen from "./zen"
