import fs from "node:fs"
import os from "node:os"
import path from "node:path"

/**
 * Resolves a provider API key.
 *
 * Prefers the environment, then falls back to the existing CodeGoblin
 * auth.json so this can be run today without re-entering keys. Keys are only
 * ever read into memory and handed to the request.
 */
export function apiKey(providerId: string): string | undefined {
  const fromEnv = process.env[`${providerId.toUpperCase()}_API_KEY`]
  if (fromEnv) return fromEnv

  const store = path.join(os.homedir(), ".local", "share", "codegoblin", "auth.json")
  try {
    const parsed = JSON.parse(fs.readFileSync(store, "utf8")) as Record<string, { type?: string; key?: string }>
    const entry = parsed[providerId]
    if (entry?.type === "api" && entry.key) return entry.key
  } catch {
    // No store, or unreadable: fall through to undefined.
  }
  return undefined
}
