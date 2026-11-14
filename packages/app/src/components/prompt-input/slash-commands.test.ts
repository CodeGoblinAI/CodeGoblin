import { describe, expect, test } from "bun:test"
import fuzzysort from "fuzzysort"
import { slashListOptions } from "./slash-commands"
import type { SlashCommand } from "./slash-popover"

const skills: SlashCommand[] = Array.from({ length: 15 }, (_, index) => ({
  id: `custom.model-${index}`,
  trigger: `models-${index}`,
  title: `models-${index}`,
  type: "custom",
  source: "skill",
}))
const settings: SlashCommand = {
  id: "model.choose",
  trigger: "model",
  aliasSearch: "models",
  title: "Choose a model",
  type: "builtin",
}

describe("web slash list priority", () => {
  test("places a matching built-in above skills while preserving fuzzy order within each kind", () => {
    const matches = fuzzysort
      .go("models", [...skills, settings], { keys: slashListOptions.filterKeys })
      .map((x) => x.obj)
    const skillOrder = matches.filter((command) => command.type === "custom")
    expect(matches.sort(slashListOptions.sortBy).slice(0, 10)).toEqual([settings, ...skillOrder.slice(0, 9)])
    expect(slashListOptions.key(settings)).toBe("model.choose")
  })

  test("keeps built-ins first when opening slash commands without a query", () => {
    expect([...skills, settings].sort(slashListOptions.sortBy)).toEqual([settings, ...skills])
  })

  test("still finds skills and does not add unrelated settings or inline commands", () => {
    const matches = fuzzysort
      .go("models-12", [...skills, settings], { keys: slashListOptions.filterKeys })
      .map((x) => x.obj)
    expect(matches.sort(slashListOptions.sortBy)).toEqual([skills[12]])
    expect([...skills].sort(slashListOptions.sortBy)).toEqual(skills)
  })
})
