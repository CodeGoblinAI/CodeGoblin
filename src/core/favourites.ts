import { pickerSection, type Selection } from "./providers"
import * as settingsStore from "./settings"

/**
 * Favourite and recent models, shared by both surfaces.
 *
 * The picker is a long list - every provider's models, then the generators -
 * and most people use three of them. The fork puts favourites and recents at
 * the top; so does this. A model shown in either section is not repeated
 * further down, so the list stays one row per model and the keyboard never
 * lands on the same model twice.
 */
export const FAVOURITES = "Favourites"
export const RECENT = "Recent"
/** How many recent models the picker shows. */
export const RECENT_SHOWN = 5
const KEPT = 50

export type PickerRow = { selection: Selection; section: string; favourite: boolean }

const idOf = (selection: Selection) => selection.provider.id + "/" + selection.model.id

/** The picker's rows, favourites and recents first, in the order they were added or used. */
export function pickerRows(selections: Selection[], prefs: { favourites: string[]; recents: string[] }): PickerRow[] {
  const byId = new Map(selections.map((selection) => [idOf(selection), selection]))
  const favourites = new Set(prefs.favourites)
  const shown = new Set<string>()
  const rows: PickerRow[] = []
  for (const id of prefs.favourites) {
    const selection = byId.get(id)
    if (!selection || shown.has(id)) continue
    shown.add(id)
    rows.push({ selection, section: FAVOURITES, favourite: true })
  }
  let recent = 0
  for (const id of prefs.recents) {
    if (recent >= RECENT_SHOWN) break
    const selection = byId.get(id)
    if (!selection || shown.has(id)) continue
    shown.add(id)
    recent++
    rows.push({ selection, section: RECENT, favourite: false })
  }
  for (const selection of selections) {
    const id = idOf(selection)
    if (shown.has(id)) continue
    rows.push({ selection, section: pickerSection(selection), favourite: favourites.has(id) })
  }
  return rows
}

const valid = (id: unknown): id is string => typeof id === "string" && /^[A-Za-z0-9._:-]+\/[A-Za-z0-9._:/-]{1,160}$/.test(id)

/**
 * Turns a model's favourite on or off, read fresh from disk and written
 * straight back: the terminal and the browser share the settings file, and
 * one holding an old copy must not wipe the other's favourites.
 */
export async function toggleFavourite(id: string): Promise<{ favourite: boolean; favourites: string[] }> {
  if (!valid(id)) throw new Error("Select a model to favourite")
  const current = await settingsStore.load()
  const favourite = !current.favourites.includes(id)
  const favourites = favourite ? [...current.favourites, id].slice(-KEPT) : current.favourites.filter((each) => each !== id)
  return { favourite, favourites: (await settingsStore.saveModelLists({ favourites })).favourites }
}

/** Records a model as just used: first in the recent list. */
export async function markRecent(id: string): Promise<string[]> {
  if (!valid(id)) return []
  const current = await settingsStore.load()
  const recents = [id, ...current.recents.filter((each) => each !== id)].slice(0, KEPT)
  if (recents.join(" ") === current.recents.join(" ")) return recents
  return (await settingsStore.saveModelLists({ recents })).recents
}
