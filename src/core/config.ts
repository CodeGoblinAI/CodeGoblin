import fs from "node:fs"
import path from "node:path"
import { parse, printParseErrorCode, type ParseError } from "jsonc-parser"
import { Global } from "../platform/paths"
import type { McpOAuthConfig } from "./mcp-oauth"

/**
 * codegoblin.jsonc, read in the shape the fork writes it.
 *
 * The file already exists on this machine. The fork created it, and it holds
 * rules written on purpose - deny patterns for every delete command that should
 * never run unattended. This app ignored it entirely, so those rules protected
 * the fork and nothing else. Reading the same file in the same shape is what
 * lets one set of rules cover both.
 *
 * Only what this app uses is kept, and only in a shape it can trust. A value of
 * the wrong type is dropped rather than coerced: a permission rule guessed into
 * existence is worse than a missing one, because it looks deliberate.
 */

export type RuleAction = "allow" | "ask" | "deny"

export type McpServer =
  | {
      type: "local"
      command: string[]
      environment: Record<string, string>
      enabled: boolean
      timeout?: number
    }
  | {
      type: "remote"
      url: string
      headers: Record<string, string>
      oauth?: McpOAuthConfig
      enabled: boolean
      timeout?: number
    }

export type Config = {
  permission: { bash: Record<string, RuleAction> }
  mcp: Record<string, McpServer>
  instructions: string[]
  /**
   * Pause and ask to continue after this many tool calls in one prompt
   * (`checkpoint`), and after this many dollars spent on one prompt (`spend`).
   *
   * Both are on by default; 0 turns one off. They used to be off unless set,
   * and a real "what effort are you on?" ran 84 steps and spent a dollar with
   * nothing to stop it but a person noticing. A value of the wrong shape falls
   * back to the default rather than to off: a typo must not remove the brake.
   */
  autonomy: { checkpoint: number; spend: number }
  /** Why the file did not parse cleanly, so a broken config is reported rather than read as empty. */
  problems: string[]
}

const ACTIONS = new Set<string>(["allow", "ask", "deny"])

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

function strings(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {}
  const out: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value)) if (typeof entry === "string") out[key] = entry
  return out
}

/** `"bash": "deny"` is shorthand for every command, the way the fork reads it. */
function rules(value: unknown): Record<string, RuleAction> {
  if (typeof value === "string") return ACTIONS.has(value) ? { "*": value as RuleAction } : {}
  if (!isRecord(value)) return {}
  const out: Record<string, RuleAction> = {}
  for (const [pattern, action] of Object.entries(value)) {
    if (pattern && typeof action === "string" && ACTIONS.has(action)) out[pattern] = action as RuleAction
  }
  return out
}

function servers(value: unknown): Record<string, McpServer> {
  if (!isRecord(value)) return {}
  const out: Record<string, McpServer> = {}
  for (const [name, entry] of Object.entries(value)) {
    if (!isRecord(entry)) continue
    const enabled = entry.enabled !== false
    const limit = entry.timeout
    const timeout = typeof limit === "number" && limit > 0 ? { timeout: limit } : {}
    const command = entry.command
    if (
      entry.type === "local" &&
      Array.isArray(command) &&
      command.length > 0 &&
      command.every((part) => typeof part === "string")
    ) {
      out[name] = { type: "local", command: command as string[], environment: strings(entry.environment), enabled, ...timeout }
    } else if (entry.type === "remote" && typeof entry.url === "string" && entry.url) {
      const oauth = entry.oauth === false ? false : isRecord(entry.oauth) ? {
        ...(typeof entry.oauth.clientId === "string" ? { clientId: entry.oauth.clientId } : {}),
        ...(typeof entry.oauth.scope === "string" ? { scope: entry.oauth.scope } : {}),
      } : undefined
      out[name] = { type: "remote", url: entry.url, headers: strings(entry.headers), enabled, ...timeout, ...(oauth !== undefined ? { oauth } : {}) }
    }
  }
  return out
}

/** Tool calls in one prompt before CG-Next asks whether to keep going. */
export const DEFAULT_CHECKPOINT = 40
/** Dollars spent on one prompt before CG-Next asks whether to keep going. */
export const DEFAULT_SPEND_LIMIT = 0.25

/** Tool calls per turn before asking to continue; 0 means never, anything malformed the default. */
function checkpoint(value: unknown): number {
  const found = isRecord(value) ? value.checkpoint : undefined
  return typeof found === "number" && Number.isInteger(found) && found >= 0 ? found : DEFAULT_CHECKPOINT
}

/** Dollars per prompt before asking to continue; 0 means never, anything malformed the default. */
function spendLimit(value: unknown): number {
  const found = isRecord(value) ? value.spend : undefined
  return typeof found === "number" && Number.isFinite(found) && found >= 0 ? found : DEFAULT_SPEND_LIMIT
}

/**
 * How many tool calls per turn before asking to continue, read fresh so an
 * edit applies to the next turn rather than the next launch. 0 means never.
 */
export function checkpointEvery(file?: string): number {
  return loadConfig(file).autonomy.checkpoint
}

/** Dollars one prompt may spend before asking to continue, read fresh like the checkpoint. 0 means never. */
export function spendLimitPerPrompt(file?: string): number {
  return loadConfig(file).autonomy.spend
}

export function parseConfig(text: string): Config {
  const errors: ParseError[] = []
  const raw: unknown = parse(text, errors, { allowTrailingComma: true })
  const root = isRecord(raw) ? raw : {}
  const permission = isRecord(root.permission) ? root.permission : {}
  return {
    permission: { bash: rules(permission.bash) },
    mcp: servers(root.mcp),
    instructions: Array.isArray(root.instructions)
      ? root.instructions.filter((entry): entry is string => typeof entry === "string")
      : [],
    autonomy: { checkpoint: checkpoint(root.autonomy), spend: spendLimit(root.autonomy) },
    problems: errors.map((error) => printParseErrorCode(error.error) + " at offset " + error.offset),
  }
}

/** Where it lives. Moves with CODEGOBLIN_DIR, like everything else under the config directory. */
export const configPath = (): string => path.join(Global.Path.config, "codegoblin.jsonc")

/**
 * Read it fresh.
 *
 * Small enough to read on every check, and reading it each time means a rule
 * added while the app is running applies to the next command rather than the
 * next launch.
 */
export function loadConfig(file: string = configPath()): Config {
  let text: string
  try {
    text = fs.readFileSync(file, "utf8")
  } catch (error) {
    const empty = parseConfig("{}")
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") empty.problems.push("Cannot read config: " + file)
    return empty
  }
  return parseConfig(text)
}
