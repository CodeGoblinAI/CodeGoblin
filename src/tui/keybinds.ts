import fs from "node:fs"
import path from "node:path"
import { parse } from "jsonc-parser"
import { Global } from "../platform/paths"

/**
 * Leader-key overrides from tui.json, in the fork's shape:
 *
 *   { "keybinds": { "leader": "ctrl+x", "model_list": "<leader>m", "app_exit": "none" } }
 *
 * The fork's file sits beside codegoblin.jsonc, so one set of bindings
 * covers both apps. Only the leader shortcuts are taken from it - the
 * actions CG-Next has - and anything it does not understand is ignored
 * rather than guessed at.
 */
export type LeaderAction =
  | "model" | "sessions" | "new" | "status" | "theme" | "agents" | "compact"
  | "undo" | "redo" | "copy" | "export" | "editor" | "timeline" | "quit"

/** The fork's names for them, and the letter each has by default. */
export const LEADER_DEFAULTS: { action: LeaderAction; fork: string; key: string; label: string }[] = [
  { action: "model", fork: "model_list", key: "m", label: "model" },
  { action: "sessions", fork: "session_list", key: "l", label: "sessions" },
  { action: "new", fork: "session_new", key: "n", label: "new" },
  { action: "status", fork: "status_view", key: "s", label: "status" },
  { action: "theme", fork: "theme_list", key: "t", label: "theme" },
  { action: "agents", fork: "agent_list", key: "a", label: "agents" },
  { action: "compact", fork: "session_compact", key: "c", label: "compact" },
  { action: "undo", fork: "messages_undo", key: "u", label: "undo" },
  { action: "redo", fork: "messages_redo", key: "r", label: "redo" },
  { action: "copy", fork: "messages_copy", key: "y", label: "copy answer" },
  { action: "export", fork: "session_export", key: "x", label: "export" },
  { action: "editor", fork: "editor_open", key: "e", label: "editor" },
  { action: "timeline", fork: "session_timeline", key: "g", label: "timeline" },
  { action: "quit", fork: "app_exit", key: "q", label: "quit" },
]

export type Keymap = { leader: string; letters: Record<string, LeaderAction>; problems: string[] }

/** The leader as a ctrl letter ("x" for ctrl+x), or undefined when the value is not one. */
function ctrlLetter(value: string): string | undefined {
  const match = /^ctrl\+([a-z])$/i.exec(value.trim())
  return match ? match[1]!.toLowerCase() : undefined
}

export function keymapFrom(raw: unknown): Keymap {
  const problems: string[] = []
  const binds = raw && typeof raw === "object" && !Array.isArray(raw) ? ((raw as { keybinds?: unknown }).keybinds as Record<string, unknown> | undefined) : undefined
  const table = binds && typeof binds === "object" && !Array.isArray(binds) ? binds : {}
  let leader = "x"
  if (typeof table.leader === "string") {
    const letter = ctrlLetter(table.leader)
    // ctrl+c quits and ctrl+s sends; they cannot also be the leader.
    if (letter && !["c", "s", "m", "i", "j"].includes(letter)) leader = letter
    else problems.push(`leader "${table.leader}" is not a ctrl+letter CG-Next can use; kept ctrl+x`)
  }
  const letters: Record<string, LeaderAction> = {}
  for (const entry of LEADER_DEFAULTS) {
    const value = table[entry.fork]
    if (value === undefined) { letters[entry.key] ??= entry.action; continue }
    if (typeof value !== "string") { problems.push(`${entry.fork} is not a string`); letters[entry.key] ??= entry.action; continue }
    if (value.trim() === "none") continue
    const keys = value.split(",").map((each) => /^<leader>([a-z0-9])$/i.exec(each.trim())?.[1]?.toLowerCase()).filter((each): each is string => Boolean(each))
    if (!keys.length) { problems.push(`${entry.fork}: "${value}" has no <leader>letter CG-Next understands`); letters[entry.key] ??= entry.action; continue }
    for (const key of keys) letters[key] = entry.action
  }
  // A default letter another action was moved onto belongs to that action.
  return { leader, letters, problems }
}

export const tuiConfigPath = () => path.join(Global.Path.config, "tui.json")

export function loadKeymap(file: string = tuiConfigPath()): Keymap {
  try {
    return keymapFrom(parse(fs.readFileSync(file, "utf8"), [], { allowTrailingComma: true }))
  } catch {
    return keymapFrom({})
  }
}
