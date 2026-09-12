import { describe, expect, test } from "bun:test"
import {
  PROVIDERS,
  allSelections,
  selectionsByKind,
  selectionsOfKind,
  resolveSelection,
  defaultSelection,
  kindOf,
  isChatModel,
  kindFromWord,
  KIND_ORDER,
  KIND_LABEL,
  exactSelection,
} from "../src/core/providers"
import { paletteFor } from "../src/tui/palette"
import { optionsForModel } from "../src/core/media-settings"

describe("what a model is for", () => {
  test("a model with no capabilities is a chat model", () => {
    expect(kindOf({ id: "x", label: "x", contextWindow: 1 })).toBe("text")
  })

  test("reads the kind off the capabilities rather than guessing from the name", () => {
    const kinds = {
      image: { output: { image: true } },
      audio: { output: { audio: true } },
      model3d: { output: { model3d: true } },
      text: { output: { text: true } },
    } as const
    for (const [expected, capabilities] of Object.entries(kinds)) {
      expect([expected, kindOf({ id: "m", label: "m", contextWindow: 0, capabilities })]).toEqual([expected, expected])
    }
  })

  test("every catalogue model lands in exactly one section", () => {
    for (const selection of allSelections()) {
      expect([selection.model.id, KIND_ORDER.includes(kindOf(selection.model))]).toEqual([selection.model.id, true])
    }
  })

  test("the sections cover the whole catalogue with nothing left over", () => {
    expect(selectionsByKind().length).toBe(allSelections().length)
  })

  test("text models come first, since that is what most prompts are", () => {
    expect(kindOf(selectionsByKind()[0]!.model)).toBe("text")
  })
})

describe("only a chat model can hold a conversation", () => {
  test("generation providers have no chat endpoint", () => {
    for (const kind of ["image", "audio", "model3d"] as const) {
      for (const selection of selectionsOfKind(kind)) {
        expect([selection.provider.id, selection.provider.baseUrl]).toEqual([selection.provider.id, undefined])
        expect(isChatModel(selection)).toBe(false)
      }
    }
  })

  test("every text model has somewhere to send a message", () => {
    for (const selection of selectionsOfKind("text")) {
      expect([selection.model.id, isChatModel(selection)]).toEqual([selection.model.id, true])
      expect(typeof selection.provider.baseUrl).toBe("string")
    }
  })

  test("the default is always something that can answer", () => {
    expect(isChatModel(defaultSelection())).toBe(true)
  })

  // A bare provider id used to take models[0]; if a provider ever leads with a
  // generation model, that would silently select something that cannot chat.
  test("a bare provider id resolves to a chat model, not whatever is first", () => {
    for (const id of Object.keys(PROVIDERS)) {
      const selection = resolveSelection(id)
      if (!selection) continue
      const hasChat = PROVIDERS[id]!.models.some((model) => kindOf(model) === "text")
      if (hasChat) expect([id, kindOf(selection.model)]).toEqual([id, "text"])
    }
  })
})

describe("narrowing the list", () => {
  test("the words someone would actually type", () => {
    expect(kindFromWord("image")).toBe("image")
    expect(kindFromWord("images")).toBe("image")
    expect(kindFromWord("3d")).toBe("model3d")
    expect(kindFromWord("voice")).toBe("audio")
    expect(kindFromWord("tts")).toBe("audio")
    expect(kindFromWord("chat")).toBe("text")
  })

  test("anything else is a search, not a section", () => {
    expect(kindFromWord("tripo")).toBeUndefined()
    expect(kindFromWord("")).toBeUndefined()
    expect(kindFromWord("gemini")).toBeUndefined()
  })

  test("every section has a label", () => {
    for (const kind of KIND_ORDER) expect(KIND_LABEL[kind].length).toBeGreaterThan(0)
  })
})

describe("the model palette", () => {
  test("shows every kind, labelled by section", () => {
    const items = paletteFor("/model ") ?? []
    expect(items.length).toBeGreaterThan(0)
    for (const item of items) expect(item.hint).toContain("·")
  })

  test("a section name filters to that section only", () => {
    const images = paletteFor("/model image") ?? []
    expect(images.length).toBe(selectionsOfKind("image").length)
    for (const item of images) expect(item.hint).toContain("Image models")

    const meshes = paletteFor("/model 3d") ?? []
    expect(meshes.length).toBe(selectionsOfKind("model3d").length)
    for (const item of meshes) expect(item.value).toContain("tripo/")
  })

  test("a provider name still searches, so /model tripo works too", () => {
    const items = paletteFor("/model tripo") ?? []
    expect(items.length).toBeGreaterThan(0)
    for (const item of items) expect(item.value).toContain("tripo/")
  })
})

describe("the catalogue groups cleanly", () => {
  // Carried over from the version lost with the drive. The panel those tests
  // were written for was not rebuilt - the /model dropdown stayed - but these
  // two are about the catalogue, not the panel, and hold either way.
  test("selections come out grouped, every kind present", () => {
    const kinds = new Set(selectionsByKind().map((s) => kindOf(s.model)))
    expect(kinds.has("text")).toBe(true)
    expect(kinds.has("image")).toBe(true)
    expect(kinds.has("model3d")).toBe(true)
  })

  test("a kind stays contiguous, so headings do not repeat", () => {
    const order = selectionsByKind().map((s) => kindOf(s.model))
    const seen = new Set<string>()
    let last: string | undefined
    for (const kind of order) {
      if (kind !== last) {
        expect(seen.has(kind)).toBe(false)
        seen.add(kind)
        last = kind
      }
    }
  })
})

describe("every model's settings are its own", () => {
  test("a setting only ever lands on a model of its kind", () => {
    for (const s of allSelections()) {
      for (const option of optionsForModel(s.provider.id, s.model.id)) {
        expect([s.provider.id + "/" + s.model.id, option.id, option.kind]).toEqual([
          s.provider.id + "/" + s.model.id,
          option.id,
          kindOf(s.model),
        ])
      }
    }
  })

  test("a chat model has no generation settings at all", () => {
    for (const s of selectionsOfKind("text")) {
      expect([s.model.id, optionsForModel(s.provider.id, s.model.id)]).toEqual([s.model.id, []])
    }
  })

  test("each generator that takes settings is reachable by some catalogue model", () => {
    // A knob no model can reach is a row in a table that nothing will ever show.
    const reachable = new Set(allSelections().flatMap((s) => optionsForModel(s.provider.id, s.model.id).map((o) => o.id)))
    for (const id of ["audio.voice", "3d.topology", "image.size"]) expect([id, reachable.has(id)]).toEqual([id, true])
  })
})

describe("naming exactly one model", () => {
  // A saved setting has to land on the model that was named. The forgiving
  // resolver is fine for starting a chat; here it would guess.
  test("the full id names that model", () => {
    const found = exactSelection("tripo/text-to-model")
    expect(found && found.provider.id + "/" + found.model.id).toBe("tripo/text-to-model")
  })

  test("nothing, or only spaces, names no model - not the default", () => {
    expect(exactSelection(undefined)).toBeUndefined()
    expect(exactSelection("")).toBeUndefined()
    expect(exactSelection("   ")).toBeUndefined()
  })

  test("a bare provider id is not a model", () => {
    expect(exactSelection("tripo")).toBeUndefined()
    expect(exactSelection("deepseek")).toBeUndefined()
  })

  test("a typo is refused rather than corrected", () => {
    expect(exactSelection("tripo/text-to-modle")).toBeUndefined()
  })

  test("every model in the catalogue can be named exactly", () => {
    for (const s of allSelections()) {
      const id = s.provider.id + "/" + s.model.id
      const found = exactSelection(id)
      expect([id, found && found.provider.id + "/" + found.model.id]).toEqual([id, id])
    }
  })
})
