import fuzzysort from "fuzzysort"

export type AutocompleteSearchOption = {
  display: string
  value?: string
  aliases?: string[]
  description?: string
  path?: string
  builtin?: boolean
}

/**
 * `recent` holds slash names used last, newest first (see slashName). For "/",
 * matches are ordered by how closely the name matches - the whole name, its
 * start, a word inside it, any part of it, then a looser match - and within
 * the same closeness by how recently it was used, then built-ins first, then
 * fuzzy relevance. Putting every built-in first regardless of closeness let a
 * weak built-in match push a skill whose name was typed out of view.
 */
export function searchAutocomplete<T extends AutocompleteSearchOption>(
  query: string,
  options: T[],
  trigger: false | "@" | "/",
  frecency: (path: string) => number,
  recent: string[] = [],
) {
  const matches = fuzzysort
    .go(removeLineRange(query), options, {
      keys: [
        (obj) => removeLineRange((obj.value ?? obj.display).trimEnd()),
        "description",
        (obj) => obj.aliases?.join(" ") ?? "",
      ],
      // Slash ordering must be applied before truncation, or a matching setting
      // can disappear behind ten better-scoring skills.
      limit: trigger === "/" ? undefined : 10,
      scoreFn: (results) => {
        const score = results[0]?.target.startsWith(trigger + query) ? results.score * 2 : results.score
        return score * (1 + (results.obj.path ? frecency(results.obj.path) : 0))
      },
    })
    .map((result) => result.obj)

  return trigger === "/" ? rankSlash(matches, query, recent).slice(0, 10) : matches
}

export function builtinFirst(a: AutocompleteSearchOption, b: AutocompleteSearchOption) {
  return Number(!!b.builtin) - Number(!!a.builtin)
}

/** The name a slash option is remembered and matched by: "/agents-sdk:skill" is "agents-sdk". */
export function slashName(option: AutocompleteSearchOption) {
  return (option.value ?? option.display)
    .trimEnd()
    .toLowerCase()
    .replace(/^\//, "")
    .replace(/:(skill|mcp)$/, "")
}

/** How closely the typed query matches an option's name or aliases: 5 exact, 4 start, 3 a word inside, 2 any part, 1 looser. */
export function slashCloseness(option: AutocompleteSearchOption, query: string) {
  const q = removeLineRange(query).toLowerCase().replace(/^\//, "")
  if (!q) return 1
  const names = [slashName(option), ...(option.aliases ?? []).map((alias) => alias.toLowerCase().replace(/^\//, ""))]
  let best = 1
  for (const name of names) {
    if (name === q) return 5
    if (name.startsWith(q)) best = Math.max(best, 4)
    else if (name.split(/[-_:.\s/]+/).some((word) => word.startsWith(q))) best = Math.max(best, 3)
    else if (name.includes(q)) best = Math.max(best, 2)
  }
  return best
}

function recency(option: AutocompleteSearchOption, recent: string[]) {
  const at = recent.indexOf(slashName(option))
  return at < 0 ? 0 : recent.length - at
}

/** `options` in fuzzy order; returns them closest first, recent first among equals, then built-ins, then fuzzy order. */
export function rankSlash<T extends AutocompleteSearchOption>(options: T[], query: string, recent: string[]) {
  return options
    .map((option, index) => ({
      option,
      index,
      closeness: slashCloseness(option, query),
      recent: recency(option, recent),
    }))
    .sort(
      (a, b) =>
        b.closeness - a.closeness || b.recent - a.recent || builtinFirst(a.option, b.option) || a.index - b.index,
    )
    .map((entry) => entry.option)
}

/** The unfiltered slash list with the ones used last first; everything else keeps its order. */
export function recentFirst<T extends AutocompleteSearchOption>(options: T[], recent: string[]) {
  if (!recent.length) return options
  return options
    .map((option, index) => ({ option, index, recent: recency(option, recent) }))
    .sort((a, b) => b.recent - a.recent || a.index - b.index)
    .map((entry) => entry.option)
}

/** Records a slash option as just used: newest first, no repeats, at most 30. */
export function noteSlashUse(recent: string[], option: AutocompleteSearchOption) {
  const name = slashName(option)
  return [name, ...recent.filter((each) => each !== name)].slice(0, 30)
}

function removeLineRange(input: string) {
  const index = input.lastIndexOf("#")
  return index === -1 ? input : input.substring(0, index)
}
