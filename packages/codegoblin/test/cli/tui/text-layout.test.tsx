/** @jsxImportSource @opentui/solid */
import { describe, expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { wrappedTextHeight } from "../../../src/cli/cmd/tui/util/text-layout"

describe("wrappedTextHeight", () => {
  test("counts explicit and word-wrapped lines", () => {
    expect(wrappedTextHeight("hello", 10)).toBe(1)
    expect(wrappedTextHeight("hello world", 10)).toBe(2)
    expect(wrappedTextHeight("hello\nworld", 10)).toBe(2)
    expect(wrappedTextHeight("hello      world", 10)).toBe(2)
  })

  test("counts hard wraps for words wider than the message", () => {
    expect(wrappedTextHeight("abcdefghijkl", 5)).toBe(3)
    expect(wrappedTextHeight("ok abcdefghijkl", 5)).toBe(4)
  })

  test("reserves every wrapped row before the assistant response", async () => {
    const prompt = "merge and build when done please"
    const width = 18
    const app = await testRender(
      () => (
        <box width={30}>
          <box width="100%" alignItems="flex-end">
            <box width={width + 4} border={["right"]}>
              <box paddingLeft={2} paddingRight={2}>
                <text width={width} height={wrappedTextHeight(prompt, width)} wrapMode="word">
                  {prompt}
                </text>
              </box>
            </box>
          </box>
          <text>ASSISTANT RESPONSE</text>
        </box>
      ),
      { width: 30, height: 8 },
    )

    try {
      await app.renderOnce()
      const rows = app
        .captureCharFrame()
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
      expect(rows).toHaveLength(3)
      expect(rows[0]).toStartWith("merge and build")
      expect(rows[1]).toStartWith("when done please")
      expect(rows[2]).toBe("ASSISTANT RESPONSE")
    } finally {
      app.renderer.destroy()
    }
  })
})
