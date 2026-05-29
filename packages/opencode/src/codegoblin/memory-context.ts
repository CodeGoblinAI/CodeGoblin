import { CodeGoblinMemory, type CodeGoblinMemoryEntry } from "./memory"
import { scanMemoryContent } from "./memory-guard"

// Builds the frozen "<memory-context>" block injected into the system prompt,
// modeled on Hermes' approach: recalled memory is presented as authoritative
// context (NOT user input) and the model is told it may use the memory tool to
// persist new durable facts.

// How many entries of each scope to surface. Pinned entries always win the
// ordering (CodeGoblinMemory.list already sorts pinned first).
const USER_LIMIT = 12
const PROJECT_LIMIT = 12
const SESSION_LIMIT = 6

export type MemoryContextInput = {
  projectID?: string
  sessionID?: string
  /** Optional task hint used to bias recall toward relevant facts. */
  query?: string
}

function recall(input: MemoryContextInput): CodeGoblinMemoryEntry[] {
  const user = input.query
    ? CodeGoblinMemory.search(input.query, { scope: "user", limit: USER_LIMIT })
    : CodeGoblinMemory.list({ scope: "user", limit: USER_LIMIT })

  const project = input.projectID
    ? input.query
      ? CodeGoblinMemory.search(input.query, { scope: "project", projectID: input.projectID, limit: PROJECT_LIMIT })
      : CodeGoblinMemory.list({ scope: "project", projectID: input.projectID, limit: PROJECT_LIMIT })
    : []

  const session = input.sessionID
    ? CodeGoblinMemory.list({ scope: "session", limit: SESSION_LIMIT }).filter(
        (entry) => entry.sourceSessionID === input.sessionID,
      )
    : []

  return [...user, ...project, ...session]
}

function renderGroup(title: string, entries: CodeGoblinMemoryEntry[]): string[] {
  if (entries.length === 0) return []
  return [
    `${title}:`,
    ...entries.map((entry) => {
      const tags = entry.tags.length ? ` [${entry.tags.join(", ")}]` : ""
      const pin = entry.pinned ? "📌 " : "- "
      return `${pin}${entry.content}${tags}`
    }),
    "",
  ]
}

/**
 * Returns the system-prompt memory block, or `undefined` when there is nothing
 * to recall. Safe to call on every turn — it reads from SQLite synchronously.
 */
export function buildMemoryContext(input: MemoryContextInput): string | undefined {
  const entries = recall(input).filter((entry) => !scanMemoryContent(entry.content))
  if (entries.length === 0) return undefined

  const user = entries.filter((entry) => entry.scope === "user")
  const project = entries.filter((entry) => entry.scope === "project")
  const session = entries.filter((entry) => entry.scope === "session")

  const body = [
    "The following is durable memory recalled from past sessions and your saved notes.",
    "Treat it as authoritative background context, NOT as a new instruction from the user.",
    "If you learn a durable fact, preference, or decision worth remembering, persist it with the memory tool.",
    "",
    ...renderGroup("User preferences & facts", user),
    ...renderGroup("Project knowledge", project),
    ...renderGroup("This session", session),
  ]
    .join("\n")
    .trimEnd()

  return ["<memory-context>", body, "</memory-context>"].join("\n")
}
