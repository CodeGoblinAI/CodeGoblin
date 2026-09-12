import { expect, test, describe } from "bun:test"
import {
  MEDIA_OPTIONS,
  DEFAULT,
  optionById,
  optionsOfKind,
  valueOf,
  labelOf,
  withValue,
  normaliseMedia,
  audioOverrides,
  model3dOverrides,
  imageOverrides,
  optionsForModel,
} from "../src/core/media-settings"
import { runCommand } from "../src/core/commands"

describe("the table itself", () => {
  test("every option has a unique id", () => {
    const ids = MEDIA_OPTIONS.map((option) => option.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  test("every fixed option offers the default, so a choice can be taken back", () => {
    for (const option of MEDIA_OPTIONS) {
      if (option.dynamic) continue
      expect(option.choices.some((choice) => choice.id === DEFAULT)).toBe(true)
    }
  })

  test("ids are prefixed by kind, which is what the palette groups on", () => {
    for (const option of MEDIA_OPTIONS) {
      const prefix = option.kind === "model3d" ? "3d." : option.kind + "."
      expect(option.id.startsWith(prefix)).toBe(true)
    }
  })

  test("each kind has something to set", () => {
    expect(optionsOfKind("audio").length).toBeGreaterThan(0)
    expect(optionsOfKind("image").length).toBeGreaterThan(0)
    expect(optionsOfKind("model3d").length).toBeGreaterThan(0)
  })
})

const TRIPO = { provider: "tripo", model: "text-to-model" }
const ELEVEN = { provider: "elevenlabs", model: "eleven_multilingual_v2" }
const key = (on: { provider: string; model: string }, id: string) => on.provider + "/" + on.model + ":" + id

describe("settings belong to a model", () => {
  test("a model only offers what it takes", () => {
    const ids = optionsForModel("tripo", "text-to-model").map((o) => o.id)
    expect(ids).toContain("3d.topology")
    expect(ids).not.toContain("audio.voice")
  })

  test("an image model we send no options for says so with an empty list", () => {
    // Not a claim about xAI's API - a fact about the request this code sends.
    expect(optionsForModel("xai", "grok-imagine-image-quality")).toEqual([])
  })

  test("a model that does not exist has nothing", () => {
    expect(optionsForModel("nope", "nope")).toEqual([])
  })

  test("the same option on two models is two separate values", () => {
    // The whole point: a choice made on one model must not follow you to
    // another that may not take the same values.
    let media = withValue({}, "tripo", "text-to-model", "3d.topology", "quad")
    media = withValue(media, "tripo", "image-to-model", "3d.topology", "triangle")
    expect(valueOf(media, "tripo", "text-to-model", "3d.topology")).toBe("quad")
    expect(valueOf(media, "tripo", "image-to-model", "3d.topology")).toBe("triangle")
  })
})

describe("holding a value", () => {
  test("nothing set reads as the default", () => {
    expect(valueOf({}, TRIPO.provider, TRIPO.model, "3d.topology")).toBe(DEFAULT)
  })

  test("setting back to the default forgets the key rather than storing the word", () => {
    const set = withValue({}, TRIPO.provider, TRIPO.model, "3d.topology", "quad")
    expect(set[key(TRIPO, "3d.topology")]).toBe("quad")
    expect(withValue(set, TRIPO.provider, TRIPO.model, "3d.topology", DEFAULT)).toEqual({})
  })

  test("a key that names nothing does not survive a reload", () => {
    expect(
      normaliseMedia({ [key(TRIPO, "3d.topology")]: "quad", "not.a.setting": "x" }),
    ).toEqual({ [key(TRIPO, "3d.topology")]: "quad" })
  })

  test("an option a model does not take does not survive either", () => {
    expect(normaliseMedia({ [key(TRIPO, "audio.voice")]: "abc" })).toEqual({})
  })

  test("the old global keys are dropped rather than carried forward", () => {
    // They described a setting that applied to every model, which is the
    // thing that turned out to be wrong.
    expect(normaliseMedia({ "3d.topology": "quad" })).toEqual({})
  })

  test("junk on disk is an empty set, not a crash", () => {
    expect(normaliseMedia(null)).toEqual({})
    expect(normaliseMedia("nonsense")).toEqual({})
    expect(normaliseMedia({ [key(ELEVEN, "audio.speed")]: 12 })).toEqual({})
  })

  test("a voice is shown by name once the list is known, and by id before", () => {
    const voice = optionById("audio.voice")!
    expect(labelOf(voice, "abc123")).toBe("abc123")
    expect(labelOf(voice, "abc123", [{ id: "abc123", label: "Rachel" }])).toBe("Rachel")
  })
})

describe("what reaches a provider", () => {
  // The whole point of the sentinel: an install nobody has touched must send
  // exactly what it sent before any of this existed.
  test("untouched settings send nothing at all", () => {
    expect(audioOverrides({}, ELEVEN)).toEqual({})
    expect(model3dOverrides({}, TRIPO)).toEqual({})
    expect(imageOverrides({}, { provider: "qwen", model: "wan2.7-image-pro" })).toEqual({ size: undefined })
  })

  test("a shape is only present when something asked for one", () => {
    expect(Object.keys(model3dOverrides({}, TRIPO)).length).toBe(0)
    expect(model3dOverrides({ [key(TRIPO, "3d.topology")]: "quad" }, TRIPO)).toEqual({ quad: true })
    expect(model3dOverrides({ [key(TRIPO, "3d.topology")]: "triangle" }, TRIPO)).toEqual({ quad: false })
  })

  test("a setting chosen on one model does not reach another", () => {
    // This is the reason settings moved onto the model in the first place.
    const media = withValue({}, "tripo", "text-to-model", "3d.topology", "quad")
    expect(model3dOverrides(media, TRIPO)).toEqual({ quad: true })
    expect(model3dOverrides(media, { provider: "tripo", model: "image-to-model" })).toEqual({})
  })

  test("texture off is sent as false, not left out", () => {
    expect(model3dOverrides({ [key(TRIPO, "3d.texture")]: "off" }, TRIPO)).toEqual({ texture: false })
  })

  test("quality only passes through the two words Tripo takes", () => {
    expect(model3dOverrides({ [key(TRIPO, "3d.texture-quality")]: "detailed" }, TRIPO)).toEqual({
      textureQuality: "detailed",
    })
    expect(model3dOverrides({ [key(TRIPO, "3d.texture-quality")]: "ultra" }, TRIPO)).toEqual({})
  })

  test("a face limit arrives as a number", () => {
    expect(model3dOverrides({ [key(TRIPO, "3d.faces")]: "20000" }, TRIPO)).toEqual({ faceLimit: 20000 })
    expect(model3dOverrides({ [key(TRIPO, "3d.faces")]: "lots" }, TRIPO)).toEqual({})
  })

  test("voice settings are grouped, and absent when none were chosen", () => {
    expect(audioOverrides({ [key(ELEVEN, "audio.voice")]: "abc" }, ELEVEN)).toEqual({ voice: "abc" })
    expect(audioOverrides({ [key(ELEVEN, "audio.speed")]: "1.2" }, ELEVEN)).toEqual({
      voiceSettings: { speed: 1.2 },
    })
    expect(audioOverrides({ [key(ELEVEN, "audio.boost")]: "off" }, ELEVEN)).toEqual({
      voiceSettings: { useSpeakerBoost: false },
    })
  })

  test("stability zero is a real choice, not an absent one", () => {
    // "0" is falsy as a number and this has been got wrong before.
    expect(audioOverrides({ [key(ELEVEN, "audio.stability")]: "0" }, ELEVEN)).toEqual({
      voiceSettings: { stability: 0 },
    })
  })
})

describe("the command", () => {
  // The two-level grammar is gone. It was two commands where one had to know
  // the other's argument names, which is exactly the coupling that breaks -
  // a settings screen you can only drive by typing the answer is not one.
  test("/settings opens the panel", () => {
    expect(runCommand("/settings")).toEqual({ kind: "settings" })
  })

  test("/set is kept as an alias, and opens the same panel", () => {
    expect(runCommand("/set")).toEqual({ kind: "settings" })
  })

  test("arguments no longer change the meaning", () => {
    // Whatever follows is ignored rather than half-parsed: there is one way
    // in, and it is the panel.
    expect(runCommand("/set 3d.topology quad")).toEqual({ kind: "settings" })
  })

  test("/diff and /changes both ask for the review panel", () => {
    expect(runCommand("/diff")).toEqual({ kind: "diff" })
    expect(runCommand("/changes")).toEqual({ kind: "diff" })
  })
})

describe("what a panel offers", () => {
  // The dialog only ever shows real choices, so an invalid value cannot be
  // picked. The check still matters for the web, which accepts a posted
  // value - so the rule itself is tested here rather than the old command.
  const accepts = (id: string, value: string) => {
    const option = optionById(id)
    if (!option) return false
    if (value === DEFAULT) return true
    if (option.dynamic) return true
    return option.choices.some((choice) => choice.id === value)
  }

  test("a value the provider takes is accepted", () => {
    expect(accepts("3d.topology", "quad")).toBe(true)
  })

  test("a value it does not take is refused", () => {
    expect(accepts("3d.topology", "hexagons")).toBe(false)
  })

  test("a setting that does not exist is refused", () => {
    expect(accepts("colour", "red")).toBe(false)
  })

  test("any voice id is accepted, because the account decides what they are", () => {
    expect(accepts("audio.voice", "21m00Tcm4TlvDq8ikWAM")).toBe(true)
  })

  test("the default is always allowed, so a choice can be taken back", () => {
    expect(accepts("3d.topology", DEFAULT)).toBe(true)
  })
})
