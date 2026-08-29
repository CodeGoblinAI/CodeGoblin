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
  describeSettings,
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

describe("holding a value", () => {
  test("nothing set reads as the default", () => {
    expect(valueOf({}, "3d.topology")).toBe(DEFAULT)
  })

  test("setting back to the default forgets the key rather than storing the word", () => {
    const set = withValue({}, "3d.topology", "quad")
    expect(set["3d.topology"]).toBe("quad")
    expect(withValue(set, "3d.topology", DEFAULT)).toEqual({})
  })

  test("a key that names nothing does not survive a reload", () => {
    expect(normaliseMedia({ "3d.topology": "quad", "not.a.setting": "x" })).toEqual({ "3d.topology": "quad" })
  })

  test("junk on disk is an empty set, not a crash", () => {
    expect(normaliseMedia(null)).toEqual({})
    expect(normaliseMedia("nonsense")).toEqual({})
    expect(normaliseMedia({ "audio.speed": 12 })).toEqual({})
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
    expect(audioOverrides({})).toEqual({})
    expect(model3dOverrides({})).toEqual({})
    expect(imageOverrides({})).toEqual({ size: undefined })
  })

  test("a shape is only present when something asked for one", () => {
    expect(Object.keys(model3dOverrides({})).length).toBe(0)
    expect(model3dOverrides({ "3d.topology": "quad" })).toEqual({ quad: true })
    expect(model3dOverrides({ "3d.topology": "triangle" })).toEqual({ quad: false })
  })

  test("texture off is sent as false, not left out", () => {
    expect(model3dOverrides({ "3d.texture": "off" })).toEqual({ texture: false })
  })

  test("quality only passes through the two words Tripo takes", () => {
    expect(model3dOverrides({ "3d.texture-quality": "detailed" })).toEqual({ textureQuality: "detailed" })
    expect(model3dOverrides({ "3d.texture-quality": "ultra" })).toEqual({})
  })

  test("a face limit arrives as a number", () => {
    expect(model3dOverrides({ "3d.faces": "20000" })).toEqual({ faceLimit: 20000 })
    expect(model3dOverrides({ "3d.faces": "lots" })).toEqual({})
  })

  test("voice settings are grouped, and absent when none were chosen", () => {
    expect(audioOverrides({ "audio.voice": "abc" })).toEqual({ voice: "abc" })
    expect(audioOverrides({ "audio.speed": "1.2" })).toEqual({ voiceSettings: { speed: 1.2 } })
    expect(audioOverrides({ "audio.boost": "off" })).toEqual({ voiceSettings: { useSpeakerBoost: false } })
  })

  test("stability zero is a real choice, not an absent one", () => {
    // "0" is falsy as a number and this has been got wrong before.
    expect(audioOverrides({ "audio.stability": "0" })).toEqual({ voiceSettings: { stability: 0 } })
  })
})

describe("the command", () => {
  test("bare /set asks for the list rather than an error", () => {
    expect(runCommand("/set")).toEqual({ kind: "set", option: "", value: "" })
  })

  test("a real setting and a real value are accepted", () => {
    expect(runCommand("/set 3d.topology quad")).toEqual({ kind: "set", option: "3d.topology", value: "quad" })
  })

  test("naming a setting without a value puts it back to the default", () => {
    expect(runCommand("/set 3d.topology")).toEqual({ kind: "set", option: "3d.topology", value: DEFAULT })
  })

  test("a value the provider does not take is refused, with the ones it does", () => {
    const result = runCommand("/set 3d.topology hexagons")
    expect(result.kind).toBe("message")
    expect(result.kind === "message" && result.text).toContain("quad")
  })

  test("an unknown setting lists what there is", () => {
    const result = runCommand("/set colour red")
    expect(result.kind).toBe("message")
    expect(result.kind === "message" && result.text).toContain("audio.voice")
  })

  test("any voice id is accepted, because the account decides what they are", () => {
    expect(runCommand("/set audio.voice 21m00Tcm4TlvDq8ikWAM")).toEqual({
      kind: "set",
      option: "audio.voice",
      value: "21m00Tcm4TlvDq8ikWAM",
    })
  })
})

test("the summary names every option, set or not", () => {
  const text = describeSettings({ "3d.topology": "quad" })
  for (const option of MEDIA_OPTIONS) expect(text).toContain(option.id)
  expect(text).toContain("quads")
})
