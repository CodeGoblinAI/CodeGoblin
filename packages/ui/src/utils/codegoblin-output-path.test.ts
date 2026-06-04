import { describe, expect, test } from "bun:test"
import {
  displayCodeGoblinOutput,
  isGlbOutputPath,
  relativeCodeGoblinOutput,
} from "./codegoblin-output-path"

describe("codegoblin output paths", () => {
  test("converts absolute Windows paths to relative API paths", () => {
    expect(
      relativeCodeGoblinOutput(
        "C:\\Users\\shawn\\Testing_Vibe\\UserSettings",
        "C:\\Users\\shawn\\Testing_Vibe\\UserSettings\\codegoblin-output\\models\\demo.glb",
      ),
    ).toBe("codegoblin-output/models/demo.glb")
  })

  test("formats relative paths for display", () => {
    expect(
      displayCodeGoblinOutput("C:\\Users\\shawn\\Testing_Vibe\\UserSettings", "codegoblin-output/models/demo.glb"),
    ).toBe("C:\\Users\\shawn\\Testing_Vibe\\UserSettings\\codegoblin-output\\models\\demo.glb")
  })

  test("detects glb outputs", () => {
    expect(isGlbOutputPath("codegoblin-output/models/demo.glb")).toBe(true)
    expect(isGlbOutputPath("C:\\demo.obj")).toBe(false)
  })
})
