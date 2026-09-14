import { describe, expect, test } from "bun:test"
import { charAfter, charBefore, deleteRange } from "../src/tui/composer"
import * as Dialogs from "../src/tui/dialog"

/** Found by driving the real terminal: every slash command, picker, paste and resize. */
describe("the composer with an emoji in it", () => {
  test("backspace takes the whole emoji, not half of it", () => {
    const text = "héllo 🧌🧌"
    const after = deleteRange({ text, cursor: text.length }, "back")
    expect(after.text).toBe("héllo 🧌")
    expect(after.text).not.toContain("�")
  })

  test("the cursor steps over an emoji in one move, both ways", () => {
    const text = "a🧌b"
    expect(charAfter(text, 1)).toBe(3)
    expect(charBefore(text, 3)).toBe(1)
    expect(charBefore(text, 1)).toBe(0)
    expect(charAfter(text, 3)).toBe(4)
  })

  test("delete forward takes the whole emoji too", () => {
    expect(deleteRange({ text: "🧌x", cursor: 0 }, "forward").text).toBe("x")
  })
})

describe("a picker row", () => {
  test("keeps its label whole and cuts the hint instead", () => {
    const dialog = Dialogs.open("approvals", "How much to ask", [
      { label: "• Ask for approval", hint: "ask before changing files, running commands or using tools from MCP servers", value: "ask" },
      { label: "  Approve for me", hint: "only ask for actions that could be unsafe or reach outside the project", value: "approve" },
    ])
    const lines = Dialogs.box(dialog, 120, 40).map(Dialogs.plain)
    expect(lines.some((line) => line.includes("Ask for approval"))).toBe(true)
    expect(lines.some((line) => line.includes("Approve for me"))).toBe(true)
  })
})
