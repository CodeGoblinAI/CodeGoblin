import { importCodexSession, listCodexSessions } from "./codex-import"
import { importClaudeSession, listClaudeSessions } from "./claude-import"

/**
 * The CLIs whose conversations /import can copy, through each one's own
 * official interface. Both surfaces read this one table, so a source added
 * here is offered in the terminal and the browser alike.
 */
export type ImportSource = "codex" | "claude"

export type ImportListing = { sessions: { id: string; title: string; updatedAt?: number }[]; next?: string }

export const IMPORTERS: Record<ImportSource, {
  label: string
  list(root: string, cursor?: string): Promise<ImportListing>
  copy(id: string, root: string, provider: string): Promise<{ id: string; title: string; messages: number }>
  omitted: string
}> = {
  codex: {
    label: "Codex", list: (root, cursor) => listCodexSessions(root, cursor), copy: (id, root, provider) => importCodexSession(id, root, provider),
    omitted: "Native tools, images, reasoning and hidden prompts omitted",
  },
  claude: {
    label: "Claude Code", list: (root, cursor) => listClaudeSessions(root, cursor), copy: (id, root, provider) => importClaudeSession(id, root, provider),
    omitted: "Tool calls and results, thinking, subagents and injected reminders omitted",
  },
}

export const importSource = (word: string | undefined): ImportSource | undefined =>
  word === "codex" ? "codex" : word === "claude" || word === "claude-code" ? "claude" : undefined
