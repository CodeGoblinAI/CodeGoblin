import { describe, expect, test } from "bun:test"
import {
  builtinFirst,
  searchAutocomplete,
  type AutocompleteSearchOption,
} from "../../../src/cli/cmd/tui/component/prompt/autocomplete-search"

const skills: AutocompleteSearchOption[] = Array.from({ length: 15 }, (_, index) => ({
  display: `/models-skill-${index}:skill`,
  description: "models",
}))
const builtin = { display: "/select-model", aliases: ["models"], builtin: true }

describe("slash autocomplete priority", () => {
  test("puts a matching built-in ahead of more than ten stronger skill matches", () => {
    const matches = searchAutocomplete("models", [...skills, builtin], "/", () => 0)
    expect(matches).toHaveLength(10)
    expect(matches[0]).toBe(builtin)
    expect(matches.slice(1).every((match) => !match.builtin)).toBe(true)
  })

  test("keeps built-ins first in the unfiltered list without reordering either group", () => {
    const custom = { display: "/aaa:skill" }
    const settings = { display: "/settings", builtin: true }
    expect([custom, builtin, ...skills, settings].sort(builtinFirst)).toEqual([builtin, settings, custom, ...skills])
  })

  test("does not surface unrelated built-ins and keeps skill-only inline search usable", () => {
    expect(searchAutocomplete("models", [...skills, { display: "/theme", builtin: true }], "/", () => 0)).toEqual(
      searchAutocomplete("models", skills, "/", () => 0),
    )
    expect(searchAutocomplete("models-skill-12", skills, "/", () => 0)[0]).toBe(skills[12])
  })

  test("preserves fuzzy relevance among built-ins", () => {
    const exact = { display: "/models", builtin: true }
    expect(searchAutocomplete("models", [builtin, ...skills, exact], "/", () => 0).slice(0, 2)).toEqual([
      exact,
      builtin,
    ])
  })

  test("does not change file search priority or line-range handling", () => {
    const options: AutocompleteSearchOption[] = [
      { display: "models-old.ts", path: "old" },
      { display: "models-new.ts", path: "new" },
      { display: "models-unrelated", builtin: true },
    ]
    const matches = searchAutocomplete("models#10-20", options, "@", (path) => (path === "new" ? 100 : 0))
    expect(matches[0]).toBe(options[1])
    expect(matches).toHaveLength(3)
  })
})
