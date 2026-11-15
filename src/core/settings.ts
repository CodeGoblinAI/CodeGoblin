import fs from "node:fs/promises"
import path from "node:path"
import { Global } from "../platform/paths"
import { APPEARANCES, DEFAULT_THEME, isTheme, type Appearance } from "./theme"

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
   * the terminal's own drag-to-select - so the app selects and copies itself
   * (tui/screen-select). On by default; it can be switched off in Settings or
   * /mouse, which hands selection back to the terminal.
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
  /** Exact provider/model identity. Unset models use auto after the first scoped save. */
  effortByModel: Record<string, Effort>
  /** Light, dark, or follow the system - the fork's light/dark lock. */
  appearance: Appearance
  /** Fold long pastes to "[Pasted ~N lines]" in the composer. */
  pasteSummary: boolean
  /** The working spinner and other motion; off draws a still marker. */
  animations: boolean
  /** Long lines in the diff viewer wrap rather than being cut at the edge. */
  diffWrap: boolean
  /** Models pinned to the top of the picker, "provider/model", in the order they were added. */
  favourites: string[]
  /** Models most recently switched to, newest first. */
  recents: string[]
  /** Holding the space bar records speech into the prompt box (terminal), once voice input is set up. */
  voiceHold: boolean
  /** A language hint for voice input; "auto" lets the model tell. */
  voiceLanguage: string
}

/**
 * Sent as the model's own effort level, except for "auto", which is sent as
 * nothing so the model's default applies. Which levels exist depends on the
 * model (providers.ts `effortLevels`); this is every name any of them uses.
 */
export type Effort = string

/** Every effort name any provider uses, weakest to strongest. */
export const EFFORT_NAMES = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]

/** The legacy fixed list, kept for older callers; models now offer their own. */
export const EFFORTS: Effort[] = ["auto", "low", "medium", "high"]

export const isEffort = (value: unknown): value is Effort =>
  typeof value === "string" && (value === "auto" || EFFORT_NAMES.includes(value))

const file = path.join(Global.Path.state, "settings.json")

export const defaults = (): Settings => ({
  theme: DEFAULT_THEME,
  thinking: true,
  mouse: true,
  effort: "auto",
  effortByModel: {},
  appearance: "dark",
  pasteSummary: true,
  animations: true,
  diffWrap: false,
  favourites: [],
  recents: [],
  voiceHold: true,
  voiceLanguage: "auto",
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
    effortByModel: value.effortByModel && typeof value.effortByModel === "object" && !Array.isArray(value.effortByModel)
      ? Object.fromEntries(Object.entries(value.effortByModel).filter(([id, level]) => modelKey(id) && isEffort(level)).slice(0, 256))
      : {},
    appearance: APPEARANCES.includes(value.appearance as Appearance) ? (value.appearance as Appearance) : base.appearance,
    pasteSummary: typeof value.pasteSummary === "boolean" ? value.pasteSummary : base.pasteSummary,
    animations: typeof value.animations === "boolean" ? value.animations : base.animations,
    diffWrap: typeof value.diffWrap === "boolean" ? value.diffWrap : base.diffWrap,
    favourites: modelList(value.favourites),
    recents: modelList(value.recents),
    voiceHold: typeof value.voiceHold === "boolean" ? value.voiceHold : base.voiceHold,
    voiceLanguage: typeof value.voiceLanguage === "string" && ["auto", "en", "zh", "yue", "ja", "ko"].includes(value.voiceLanguage) ? value.voiceLanguage : base.voiceLanguage,
  }
}

/** A list of model ids, cleaned: valid ids, no repeats, at most 50. */
function modelList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  return [...new Set(raw.filter((id): id is string => typeof id === "string" && modelKey(id)))].slice(0, 50)
}

const modelKey = (id: string) => /^[A-Za-z0-9._:-]+\/[A-Za-z0-9._:/-]{1,160}$/.test(id)

export function effortForModel(settings: Settings, id: string): Effort {
  if (Object.hasOwn(settings.effortByModel, id)) return settings.effortByModel[id]!
  // Preserve the legacy global preference until the first per-model choice.
  return Object.keys(settings.effortByModel).length ? "auto" : settings.effort
}

export function withModelEffort(settings: Settings, id: string, level: unknown): Settings {
  if (!modelKey(id) || !isEffort(level)) throw new Error("Select a valid model and effort level")
  return { ...settings, effortByModel: Object.fromEntries([...Object.entries(settings.effortByModel).filter(([key]) => key !== id), [id, level]].slice(-256)) }
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

/**
 * Writes the preferences, keeping the favourite and recent models already on
 * disk. Both surfaces share this file and each holds its own copy of the rest;
 * a terminal that loaded at startup must not wipe a favourite starred in the
 * browser since. Those two lists change only through saveModelLists.
 */
export async function save(settings: Settings): Promise<void> {
  const disk = await load()
  await write({ ...settings, favourites: disk.favourites, recents: disk.recents })
}

/** Changes the favourite or recent models, read fresh and written straight back. */
export async function saveModelLists(lists: { favourites?: string[]; recents?: string[] }): Promise<Settings> {
  const disk = await load()
  const next = normalise({ ...disk, ...lists })
  await write(next)
  return next
}

async function write(settings: Settings): Promise<void> {
  try {
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, JSON.stringify(settings, null, 2), "utf8")
  } catch {
    // A preference that cannot be written is not worth interrupting anyone.
  }
}
