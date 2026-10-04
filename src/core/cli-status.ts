import { claudeAuthStatus } from "./claude-cli"
import { codexAuthStatus } from "./codex-chat"
import { cursorAuthStatus } from "./cursor-sdk"

export const cliAuthStatus = (id: string) => id === "codex" ? codexAuthStatus() : id === "cursor" || id === "cursor-api" ? cursorAuthStatus(id) : claudeAuthStatus()

export async function cliStatuses() {
  return Object.fromEntries(await Promise.all(["claude-code", "codex", "cursor", "cursor-api"].map(async (id) => [id, await cliAuthStatus(id)])))
}
