import fs from "node:fs"
import fsp from "node:fs/promises"
import path from "node:path"
import { Global } from "../platform/paths"
import { catalogEnv } from "./catalog"

/**
 * Where API keys live.
 *
 * On this machine and nowhere else. A key is read from the environment or from
 * a file in the user's own data directory, handed to the request that needs
 * it, and written nowhere else - not into a session, not into a transcript,
 * not into a log. Nothing here sends a key anywhere except the provider it
 * belongs to.
 *
 * The file is written owner-only, the way the original writes it. That holds
 * on POSIX. On Windows it does not: Node maps mode onto the read-only
 * attribute and nothing else, so the file stays readable by the account and
 * anything running as it. Saying so is better than implying a protection
 * that is not there - restricting it properly needs an ACL, not a mode.
 */

export type ApiAuth = { type: "api"; key: string }
export type StoredAuth = { type: string; key?: string; [field: string]: unknown }

const file = path.join(Global.Path.data, "auth.json")

/** Owner read/write only, where the platform honours it. */
const SECRET_MODE = 0o600

const envName = (providerId: string) => providerId === "cursor-api" ? "CURSOR_API_KEY" : `${providerId.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`

function readStore(): Record<string, StoredAuth> {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"))
    return parsed && typeof parsed === "object" ? (parsed as Record<string, StoredAuth>) : {}
  } catch {
    // No store, or unreadable: no keys. Never a reason to fail to start.
    return {}
  }
}

async function writeStore(store: Record<string, StoredAuth>): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true })
  // Through a temporary file, so an interrupted write cannot leave the store
  // truncated and lose every other key along with it. Created owner-only from
  // the start rather than relaxed afterwards.
  const temporary = file + ".tmp"
  await fsp.writeFile(temporary, JSON.stringify(store, null, 2), { encoding: "utf8", mode: SECRET_MODE })
  await fsp.rename(temporary, file)
  await fsp.chmod(file, SECRET_MODE).catch(() => {})
}

/**
 * Every secret value CG-Next knows of: each string in the key store (keys,
 * OAuth access and refresh tokens) and each environment variable whose name
 * says it is a key, a secret, a token or a password. Short values are left
 * out - masking "true" or "api" everywhere would garble ordinary output.
 *
 * Tool output is scrubbed of these before the model sees it. A real run did
 * `type auth.json` and sent every stored key to the provider, into the saved
 * conversation, and onto the screen.
 */
export function storedSecrets(env: NodeJS.ProcessEnv = process.env): string[] {
  const found = new Set<string>()
  // By field name, so a stored base URL or account label is not masked in code the model reads.
  const SECRET_FIELD = /key|token|secret|access|refresh|password/i
  const collect = (value: unknown, secret: boolean) => {
    if (typeof value === "string") { if (secret && value.length >= 16) found.add(value); return }
    if (value && typeof value === "object") for (const [name, inner] of Object.entries(value)) collect(inner, SECRET_FIELD.test(name))
  }
  for (const entry of Object.values(readStore())) collect(entry, false)
  for (const [name, value] of Object.entries(env)) collect(value, SECRET_FIELD.test(name))
  // Longest first, so a key that contains another is masked whole.
  return [...found].sort((a, b) => b.length - a.length)
}

/**
 * Resolves a provider API key.
 *
 * The environment wins, so a key can be supplied for one run without being
 * written down at all.
 */
export function apiKey(providerId: string): string | undefined {
  // Local servers need no key; the CLI owns its own authentication. Never forward a stored key.
  if (providerId === "local" || providerId === "llama" || providerId === "claude-code" || providerId === "codex" || providerId === "cursor") return ""
  const fromEnv = process.env[envName(providerId)]
  if (fromEnv) return fromEnv
  // A models.dev provider's key under the name the catalog gives (GOOGLE_GENERATIVE_AI_API_KEY and so on).
  for (const name of catalogEnv(providerId)) if (process.env[name]) return process.env[name]

  const entry = readStore()[providerId]
  if (entry?.type === "api" && typeof entry.key === "string" && entry.key) return entry.key
  return undefined
}

/** Enough to recognise a key you already have, and useless to anyone else. */
export function maskKey(key: string): string {
  return key.length <= 4 ? "····" : "····" + key.slice(-4)
}

export type Connection = {
  id: string
  /** "api" for a key that was pasted, "oauth" for a provider that was logged in to. */
  type: string
  /** Where it came from, so an environment key is not mistaken for a stored one. */
  source: "environment" | "file"
  hint?: string
}

export function connections(): Connection[] {
  const found: Connection[] = Object.entries(readStore()).map(([id, entry]) => ({
    id,
    type: entry.type,
    source: "file" as const,
    hint: entry.type === "api" && typeof entry.key === "string" ? maskKey(entry.key) : undefined,
  }))

  // An environment key never appears in the file, and someone wondering why a
  // provider works without being connected deserves to see why.
  for (const name of Object.keys(process.env)) {
    if (!name.endsWith("_API_KEY")) continue
    const id = name === "CURSOR_API_KEY" ? "cursor-api" : name.slice(0, -"_API_KEY".length).toLowerCase()
    if (found.some((connection) => connection.id === id)) continue
    found.push({ id, type: "api", source: "environment" })
  }

  return found.sort((a, b) => a.id.localeCompare(b.id))
}

export function isConnected(providerId: string): boolean {
  return Boolean(apiKey(providerId))
}

export async function connect(providerId: string, key: string): Promise<void> {
  const trimmed = key.trim()
  if (!trimmed) throw new Error("no key given")
  const store = readStore()
  store[providerId] = { type: "api", key: trimmed }
  await writeStore(store)
}

export async function disconnect(providerId: string): Promise<boolean> {
  const store = readStore()
  if (!(providerId in store)) return false
  delete store[providerId]
  await writeStore(store)
  return true
}

/** The path, for telling someone where their keys are. Never the contents. */
export function storePath(): string {
  return file
}

/** The variable that would supply this provider's key without storing it. */
export function envVariable(providerId: string): string {
  return catalogEnv(providerId)[0] ?? envName(providerId)
}
