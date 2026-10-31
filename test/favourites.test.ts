import { describe, expect, test, beforeEach } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { Global } from "../src/platform/paths"
import { FAVOURITES, RECENT, RECENT_SHOWN, markRecent, pickerRows, toggleFavourite } from "../src/core/favourites"
import type { Provider, Selection } from "../src/core/providers"
import * as settingsStore from "../src/core/settings"
import { runCommand as parseCommand } from "../src/core/commands"
import { paletteFor, setModelLists } from "../src/tui/palette"

const provider = (id: string, models: string[], local = false): Provider =>
  ({ id, label: id.toUpperCase(), models: models.map((m) => ({ id: m, label: m, contextWindow: 1000 })), ...(local ? { local: true } : {}) }) as unknown as Provider
const zai = provider("zai", ["glm-a", "glm-b", "glm-c"])
const ds = provider("deepseek", ["chat", "reasoner"])
const all: Selection[] = [...zai.models.map((model) => ({ provider: zai, model })), ...ds.models.map((model) => ({ provider: ds, model }))]
const ids = (rows: ReturnType<typeof pickerRows>) => rows.map((row) => `${row.section}:${row.selection.provider.id}/${row.selection.model.id}${row.favourite ? "*" : ""}`)

describe("the picker order", () => {
  test("favourites first, then recent, then everything else - each model once", () => {
    const rows = pickerRows(all, { favourites: ["deepseek/reasoner"], recents: ["zai/glm-c", "deepseek/reasoner", "zai/glm-a"] })
    expect(ids(rows)).toEqual([
      `${FAVOURITES}:deepseek/reasoner*`,
      `${RECENT}:zai/glm-c`,
      `${RECENT}:zai/glm-a`,
      "Text models:zai/glm-b",
      "Text models:deepseek/chat",
    ])
  })

  test("with none of either, it is the plain list", () => {
    expect(ids(pickerRows(all, { favourites: [], recents: [] })).every((row) => row.startsWith("Text models:"))).toBe(true)
  })

  test("a favourite or recent model that no longer exists is skipped, and recent shows at most five", () => {
    const many = Array.from({ length: 8 }, (_, i) => provider("p" + i, ["m"]))
    const selections = many.map((p) => ({ provider: p, model: p.models[0]! }))
    const rows = pickerRows(selections, { favourites: ["gone/model"], recents: many.map((p) => p.id + "/m") })
    expect(rows.filter((row) => row.section === RECENT).length).toBe(RECENT_SHOWN)
    expect(rows.some((row) => row.section === FAVOURITES)).toBe(false)
    expect(rows.length).toBe(8)
  })
})

describe("favourites and recents are saved, and shared safely", () => {
  const file = path.join(Global.Path.state, "settings.json")
  beforeEach(() => { try { fs.rmSync(file) } catch {} })

  test("starring toggles, and survives a reload", async () => {
    expect(await toggleFavourite("zai/glm-5.3")).toEqual({ favourite: true, favourites: ["zai/glm-5.3"] })
    expect((await settingsStore.load()).favourites).toEqual(["zai/glm-5.3"])
    expect(await toggleFavourite("zai/glm-5.3")).toEqual({ favourite: false, favourites: [] })
  })

  test("recent puts the latest first and drops repeats", async () => {
    await markRecent("a/one")
    await markRecent("b/two")
    expect(await markRecent("a/one")).toEqual(["a/one", "b/two"])
  })

  test("a surface saving its other settings does not wipe a favourite starred elsewhere", async () => {
    const terminal = await settingsStore.load() // loaded before the browser starred anything
    await toggleFavourite("zai/glm-5.3") // the browser stars a model
    await settingsStore.save({ ...terminal, theme: "dracula" }) // the terminal changes its theme
    const after = await settingsStore.load()
    expect(after.theme).toBe("dracula")
    expect(after.favourites).toEqual(["zai/glm-5.3"])
  })

  test("junk in the file is ignored rather than trusted", async () => {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify({ favourites: ["ok/model", 7, "no slash here", "ok/model"], recents: "nope" }))
    const loaded = await settingsStore.load()
    expect(loaded.favourites).toEqual(["ok/model"])
    expect(loaded.recents).toEqual([])
    await expect(toggleFavourite("not a model")).rejects.toThrow()
  })
})

describe("the command", () => {
  test("/favourite, its aliases, and with a model", () => {
    expect(parseCommand("/favourite")).toEqual({ kind: "favourite" })
    expect(parseCommand("/fav zai/glm-5.3")).toEqual({ kind: "favourite", id: "zai/glm-5.3" })
    expect(parseCommand("/favorite")).toEqual({ kind: "favourite" })
  })

  test("the terminal's /model and /favourite lists put favourites first, starred", () => {
    setModelLists({ favourites: ["zai/glm-5.3-flash"], recents: [] })
    const models = paletteFor("/model ") ?? []
    expect(models[0]?.value).toBe("/model zai/glm-5.3-flash")
    expect(models[0]?.hint).toStartWith("★ Favourites")
    const stars = paletteFor("/favourite ") ?? []
    expect(stars[0]?.value).toBe("/favourite zai/glm-5.3-flash")
    setModelLists({ favourites: [], recents: [] })
  })
})
