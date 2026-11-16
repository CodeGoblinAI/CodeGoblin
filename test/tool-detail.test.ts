import { describe, expect, test } from "bun:test"
import { toolDetail } from "../src/tui/tool-detail"

const args = (value: Record<string, unknown>) => JSON.stringify(value)

describe("what shows under a finished tool call", () => {
  test("a command's output goes under it, a few lines and a count of the rest; the exit code goes on the row", () => {
    const output = Array.from({ length: 10 }, (_, index) => "line " + (index + 1)).join("\n")
    const shown = toolDetail("shell", args({ command: "ls" }), output)
    expect(shown.summary).toBe("")
    expect(shown.lines.map((line) => line.text)).toEqual(["line 1", "line 2", "line 3", "line 4", "… +6 lines"])
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
    expect(toolDetail("read_file", args({ path: "x" }), "error: no such file\nmore\nmore\nmore")).toEqual({ summary: "", lines: [{ text: "error: no such file" }, { text: "more" }, { text: "more" }, { text: "… +1 line", tone: "more" }] })
    expect(toolDetail("glob", args({ pattern: "*.md" }), "README.md\nnotes.md")).toEqual({ summary: "README.md", lines: [] })
    expect(toolDetail("read_file", args({ path: "x" }), "x".repeat(100)).summary).toHaveLength(60)
    // Arguments that are not JSON do not break it.
    expect(toolDetail("write_file", "not json", "wrote it").summary).toBe("wrote it")
  })

  test("a background job's row says its state, with what it printed under it", () => {
    const started = toolDetail("shell", args({ command: "bun dev", background: true }), 'started job1 in the background: bun dev\ncompiling\n(still running. job_output with id "job1" reads what it prints next)')
    expect(started).toEqual({ summary: "started job1", lines: [{ text: "compiling" }] })
    expect(toolDetail("shell", args({ command: "bun dev", background: true }), "started job2 in the background: bun dev\n(no output yet)\n(still running. job_output ...)")).toEqual({ summary: "started job2", lines: [] })
    expect(toolDetail("shell", args({ command: "bun x", background: true }), "job3 ended straight away (ended with exit code 1 after 0s): bun x\nnot found").summary).toBe("job3 ended straight away (ended with exit code 1 after 0s)")
    expect(toolDetail("job_output", args({ id: "job1" }), "job1: running for 4s\nReady on :4000")).toEqual({ summary: "job1: running for 4s", lines: [{ text: "Ready on :4000" }] })
    expect(toolDetail("job_output", args({ id: "job1" }), "job1: running for 9s\n(nothing new since it was last read)")).toEqual({ summary: "job1: running for 9s", lines: [] })
    expect(toolDetail("job_stop", args({ id: "job1" }), "job1 stopped: bun dev").summary).toBe("job1 stopped: bun dev")
  })

  test("a command that outlived its wait says so on its row, with what it had printed under it", () => {
    const trailer = '... still running after 2m. It was not stopped: it carries on in the background as job2.\n(job_output with id "job2" reads what it prints next - wait_ms waits for more, "until" for a particular line; job_stop ends it.)'
    expect(toolDetail("shell", args({ command: "bun index.js" }), "indexed 40 / 2800000\nindexed 80 / 2800000\n" + trailer)).toEqual({
      summary: "still running after 2m - carries on as job2 (/jobs)",
      lines: [{ text: "indexed 40 / 2800000" }, { text: "indexed 80 / 2800000" }],
    })
    expect(toolDetail("shell", args({ command: "sleep 900" }), "(no output yet)\n" + trailer)).toEqual({ summary: "still running after 2m - carries on as job2 (/jobs)", lines: [] })
    // Opened by a click, the same call shows far more of its output.
    const long = Array.from({ length: 40 }, (_, n) => "line " + (n + 1)).join("\n")
    expect(toolDetail("shell", args({ command: "x" }), long).lines.length).toBe(5)
    expect(toolDetail("shell", args({ command: "x" }), long, 300).lines.length).toBe(40)
  })
})

describe("a command that failed", () => {
  test("is folded to its end, where the error is, with a count of what came before", () => {
    const output = Array.from({ length: 30 }, (_, index) => "compiling " + (index + 1)).join("\n") + "\nerror TS2322: wrong type\nbuild failed\nexit code 2"
    const shown = toolDetail("shell", args({ command: "bun run build" }), output)
    expect(shown.summary).toBe("exit code 2")
    expect(shown.lines.map((line) => line.text)).toEqual(["… +28 earlier lines", "compiling 29", "compiling 30", "error TS2322: wrong type", "build failed"])
    expect(shown.lines[0]!.tone).toBe("more")
    // Opened, it is all there from the start.
    expect(toolDetail("shell", args({ command: "bun run build" }), output, 300).lines[0]!.text).toBe("compiling 1")
    // One that worked is folded to its start.
    expect(toolDetail("shell", args({ command: "x" }), output.replace("exit code 2", "exit code 0")).lines[0]!.text).toBe("compiling 1")
  })
})
