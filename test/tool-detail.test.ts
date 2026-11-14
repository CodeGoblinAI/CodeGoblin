import { describe, expect, test } from "bun:test"
import { toolDetail } from "../src/tui/tool-detail"

const args = (value: Record<string, unknown>) => JSON.stringify(value)

describe("what shows under a finished tool call", () => {
  test("a command's output goes under it, a few lines and a count of the rest; the exit code goes on the row", () => {
    const output = Array.from({ length: 10 }, (_, index) => "line " + (index + 1)).join("\n")
    const shown = toolDetail("shell", args({ command: "ls" }), output)
    expect(shown.summary).toBe("")
    expect(shown.lines.map((line) => line.text)).toEqual(["line 1", "line 2", "line 3", "line 4", "line 5", "line 6", "… 4 more lines"])
    expect(shown.lines.at(-1)!.tone).toBe("more")
    const failed = toolDetail("shell", args({ command: "false" }), "nope\nexit code 1")
    expect(failed).toEqual({ summary: "exit code 1", lines: [{ text: "nope" }] })
    expect(toolDetail("shell", args({ command: "true" }), "(no output)")).toEqual({ summary: "no output", lines: [] })
    expect(toolDetail("shell", args({ command: "x" }), "(no output)\nexit code 2").summary).toBe("exit code 2")
  })

  test("a written file shows what it now says, numbered", () => {
    const shown = toolDetail("write_file", args({ path: "notes.md", content: "# Notes\n\n- a guard was added\n" }), "wrote notes.md")
    expect(shown.summary).toBe("")
    expect(shown.lines.map((line) => line.text)).toEqual(["1  # Notes", "2  ", "3  - a guard was added"])
  })

  test("an edit shows what went and what came, coloured by which", () => {
    const shown = toolDetail("edit_file", args({ path: "a.js", old_string: "return a - b", new_string: "return a + b" }), "edited a.js")
    expect(shown.lines).toEqual([{ text: "- return a - b", tone: "remove" }, { text: "+ return a + b", tone: "add" }])
  })

  test("a question's answer goes on the row", () => {
    expect(toolDetail("question", args({}), 'The user answered "Which runtime?": "Bun (Recommended)", "Deno".').summary).toBe("answered Bun (Recommended), Deno")
    expect(toolDetail("question", args({}), 'The user dismissed the question "Which?" without answering. Do not ask it again.').summary).toBe("dismissed")
  })

  test("a failure shows its first lines under the row; reads and searches keep their first line", () => {
    expect(toolDetail("read_file", args({ path: "x" }), "error: no such file\nmore\nmore\nmore")).toEqual({ summary: "", lines: [{ text: "error: no such file" }, { text: "more" }, { text: "more" }, { text: "… 1 more line", tone: "more" }] })
    expect(toolDetail("glob", args({ pattern: "*.md" }), "README.md\nnotes.md")).toEqual({ summary: "README.md", lines: [] })
    expect(toolDetail("read_file", args({ path: "x" }), "x".repeat(100)).summary).toHaveLength(60)
    // Arguments that are not JSON do not break it.
    expect(toolDetail("write_file", "not json", "wrote it").summary).toBe("wrote it")
  })
})
