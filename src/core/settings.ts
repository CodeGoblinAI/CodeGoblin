import fs from "node:fs/promises"
import path from "node:path"
import { Global } from "../platform/paths"
import { DEFAULT_THEME, isTheme } from "./theme"

/**
 * The handful of preferences worth remembering.
 *
 * A theme that resets every launch is not a theme, it is a party trick. This
 * is deliberately tiny: two fields, one file, no schema versioning. When it
 * needs more than that it should become a real config file rather than
 * growing quietly.
 */
export type Settings = {
  theme: string
  /** Whether the model's reasoning is shown. Useful, but not everyone wants it. */
  thinking: boolean
}

const file = path.join(Global.Path.state, "settings.json")

export const defaults = (): Settings => ({ theme: DEFAULT_THEME, thinking: true })

export function normalise(raw: unknown): Settings {
  const base = defaults()
  if (!raw || typeof raw !== "object") return base
  const value = raw as Partial<Settings>
  return {
    theme: typeof value.theme === "string" && isTheme(value.theme) ? value.theme : base.theme,
    thinking: typeof value.thinking === "boolean" ? value.thinking : base.thinking,
  }
}

export async function load(): Promise<Settings> {
  try {
    return normalise(JSON.parse(await fs.readFile(file, "utf8")))
  } catch {
    // No file, unreadable file, or something that is not JSON: the defaults
    // are a perfectly good answer, and losing a preference is not worth an
    // error message at startup.
    return defaults()
  }
}

export async function save(settings: Settings): Promise<void> {
  try {
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, JSON.stringify(settings, null, 2), "utf8")
  } catch {
    // A preference that cannot be written is not worth interrupting anyone.
  }
}
