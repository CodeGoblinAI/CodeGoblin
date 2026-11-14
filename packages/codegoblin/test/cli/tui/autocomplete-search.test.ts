import { describe, expect, test } from "bun:test"
import {
  builtinFirst,
  searchAutocomplete,
  slashCloseness,
  noteSlashUse,
  recentFirst,
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

describe("slash autocomplete closeness and recency", () => {
  const settings = { display: "/settings", builtin: true }
  const browserSkill = { display: "/chrome-browser:skill", description: "drive Chrome" }
  const builtInBrowser = { display: "/built-in-browser:skill", description: "the app's browser pane" }
  const weakBuiltin = { display: "/branch-overview", builtin: true }

  test("a skill whose name holds the typed word beats a built-in that only loosely matches", () => {
    const matches = searchAutocomplete("browser", [weakBuiltin, settings, browserSkill, builtInBrowser], "/", () => 0)
    expect(
      matches
        .slice(0, 2)
        .map((m) => m.display)
        .sort(),
    ).toEqual(["/built-in-browser:skill", "/chrome-browser:skill"])
  })

  test("closeness tiers: exact, start, a word inside, anywhere, looser", () => {
    expect(slashCloseness({ display: "/models" }, "models")).toBe(5)
    expect(slashCloseness({ display: "/models-skill-1:skill" }, "models")).toBe(4)
    expect(slashCloseness({ display: "/chrome-browser:skill" }, "browser")).toBe(3)
    expect(slashCloseness({ display: "/abrowserz" }, "browser")).toBe(2)
    expect(slashCloseness({ display: "/bxrxowxsxer" }, "browser")).toBe(1)
    expect(slashCloseness({ display: "/x", aliases: ["models"] }, "models")).toBe(5)
  })

  test("among equally close matches the one used last comes first, ahead of a built-in", () => {
    const recent = noteSlashUse([], builtInBrowser)
    expect(recent).toEqual(["built-in-browser"])
    const matches = searchAutocomplete("browser", [browserSkill, builtInBrowser], "/", () => 0, recent)
    expect(matches[0]).toBe(builtInBrowser)
    // Recency never lifts a looser match above a closer one.
    const exact = { display: "/browser", builtin: true }
    expect(searchAutocomplete("browser", [browserSkill, builtInBrowser, exact], "/", () => 0, recent)[0]).toBe(exact)
  })

  test("the unfiltered list puts recently used first and leaves the rest in order", () => {
    const list = [settings, weakBuiltin, browserSkill, builtInBrowser]
    expect(recentFirst(list, [])).toBe(list)
    expect(recentFirst(list, ["chrome-browser"]).map((m) => m.display)).toEqual([
      "/chrome-browser:skill",
      "/settings",
      "/branch-overview",
      "/built-in-browser:skill",
    ])
    expect(noteSlashUse(["a", "b"], { display: "/b" })).toEqual(["b", "a"])
  })
})
