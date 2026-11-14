import fuzzysort from "fuzzysort"

export type AutocompleteSearchOption = {
  display: string
  value?: string
  aliases?: string[]
  description?: string
  path?: string
  builtin?: boolean
}

export function searchAutocomplete<T extends AutocompleteSearchOption>(
  query: string,
  options: T[],
  trigger: false | "@" | "/",
  frecency: (path: string) => number,
) {
  const matches = fuzzysort
    .go(removeLineRange(query), options, {
      keys: [
        (obj) => removeLineRange((obj.value ?? obj.display).trimEnd()),
        "description",
        (obj) => obj.aliases?.join(" ") ?? "",
      ],
      // Slash priority must be applied before truncation, or a matching setting
      // can disappear behind ten better-scoring skills.
      limit: trigger === "/" ? undefined : 10,
      scoreFn: (results) => {
        const score = results[0]?.target.startsWith(trigger + query) ? results.score * 2 : results.score
        return score * (1 + (results.obj.path ? frecency(results.obj.path) : 0))
      },
    })
    .map((result) => result.obj)

  return trigger === "/" ? matches.sort(builtinFirst).slice(0, 10) : matches
}

export function builtinFirst(a: AutocompleteSearchOption, b: AutocompleteSearchOption) {
  return Number(!!b.builtin) - Number(!!a.builtin)
}

function removeLineRange(input: string) {
  const index = input.lastIndexOf("#")
  return index === -1 ? input : input.substring(0, index)
}
