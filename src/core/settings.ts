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
  /**
   * Whether the app takes the mouse.
   *
   * A real trade, and the original makes it a setting rather than a choice:
   * taking the mouse gets wheel scrolling and clickable things, and costs
   * the terminal's own drag-to-select. On by default for clickable controls;
   * it can be switched off in Settings or /mouse. Shift+drag
   * still selects in most terminals when it is on.
   */
  mouse: boolean
  /**
   * How hard a reasoning model should think.
   *
   * "auto" sends nothing and lets the provider pick, which is the right
   * default: an effort we chose is a guess about a model we did not train.
   * The other three ride along as reasoning_effort, and only on models that
   * declare themselves reasoning models - sending it to one that does not
   * understand it is how a provider starts rejecting whole requests.
   */
  effort: Effort
}

/** Sent as reasoning_effort, except for "auto", which is sent as nothing. */
export type Effort = "auto" | "low" | "medium" | "high"

export const EFFORTS: Effort[] = ["auto", "low", "medium", "high"]

export const isEffort = (value: unknown): value is Effort =>
  typeof value === "string" && (EFFORTS as string[]).includes(value)

const file = path.join(Global.Path.state, "settings.json")

export const defaults = (): Settings => ({
  theme: DEFAULT_THEME,
  thinking: true,
  mouse: true,
  effort: "auto",
})

export function normalise(raw: unknown): Settings {
  const base = defaults()
  if (!raw || typeof raw !== "object") return base
  const value = raw as Partial<Settings>
  return {
    theme: typeof value.theme === "string" && isTheme(value.theme) ? value.theme : base.theme,
    thinking: typeof value.thinking === "boolean" ? value.thinking : base.thinking,
    mouse: typeof value.mouse === "boolean" ? value.mouse : base.mouse,
    effort: isEffort(value.effort) ? value.effort : base.effort,
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
