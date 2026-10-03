import { expect, test } from "bun:test"
import { ctrlCAction, dialogRowAt, insideDialog } from "../src/tui/interaction"
import { parseKeys } from "../src/tui/keys"
import { runCommand, normalizeCommand, PENDING_COMMANDS } from "../src/core/commands"
import { addSpend, formatSpend } from "../src/core/context"
import { localChatMessages } from "../src/core/agent"

test("Ctrl+C copies selection, stops work, clears drafts, then quits", () => {
  const state = { selected: true, busy: true, draft: true, secret: false }
  expect(ctrlCAction(state)).toBe("copy")
  expect(ctrlCAction({ ...state, selected: false })).toBe("stop")
  expect(ctrlCAction({ ...state, selected: false, busy: false })).toBe("clear")
  expect(ctrlCAction({ ...state, secret: true, busy: false })).toBe("clear")
  expect(ctrlCAction({ selected: false, busy: false, draft: false, secret: false })).toBe("quit")
})
test("SGR press, drag and release parse; right clicks do not", () => {
  expect(parseKeys("\x1b[<0;3;23M\x1b[<0;3;23m")).toEqual([
    { type: "press", col: 3, row: 23 },
    { type: "click", col: 3, row: 23 },
  ])
  expect(parseKeys("\x1b[<32;5;10M")).toEqual([{ type: "drag", col: 5, row: 10 }])
  expect(parseKeys("\x1b[<2;3;23m")).toEqual([])
})
test("dialog hit testing matches visible rows including scroll offset", () => {
  const frame = { cols: 100, rows: 40, width: 60, height: 10, boxHeight: 15, first: 6, col: 25, row: 14 }
  expect(dialogRowAt(frame)).toBe(6)
  expect(dialogRowAt({ ...frame, row: 13 })).toBeUndefined()
  expect(dialogRowAt({ ...frame, col: 1 })).toBeUndefined()
})
test("a click on the dialog box itself is not a click outside it", () => {
  const frame = { cols: 100, rows: 40, width: 60, boxHeight: 15, col: 25, row: 13 }
  // Row 13 is the title area: no row there, but still the box.
  expect(insideDialog(frame)).toBe(true)
  expect(insideDialog({ ...frame, col: 1 })).toBe(false)
  expect(insideDialog({ ...frame, row: 30 })).toBe(false)
})
test("slash aliases route to implemented commands; deferred commands never invoke models", () => {
  expect(runCommand("/models deepseek")).toEqual(runCommand("/model deepseek"))
  expect(runCommand("/usage")).toEqual({ kind: "usage" })
  expect(runCommand("/status")).toEqual({ kind: "status" })
  expect(normalizeCommand("please /models")).toBe("please /models")
  for (const command of Object.keys(PENDING_COMMANDS)) expect(runCommand(command).kind).toBe("message")
})
test("switching between priced and unpriced models cannot silently understate cost", () => {
  const sum = addSpend({ input: 10, output: 5, dollars: 0.1 }, { input: 3, output: 4 })
  expect(sum.unpriced).toBe(true)
  expect(formatSpend(sum)).toContain("unpriced")
  expect(formatSpend(addSpend({ input: 10, output: 5 }, { input: 3, output: 4, dollars: 0 }))).toContain("unpriced")
})

test("local chat context excludes the coding-agent prompt it does not send", () => {
  const sent = localChatMessages([
    { role: "system", content: "x".repeat(4000) },
    { role: "user", content: "hello" },
    { role: "assistant", content: "hi" },
    { role: "tool", content: "not sent", tool_call_id: "1" },
  ])
  expect(sent.map((message) => message.role)).toEqual(["system", "user", "assistant"])
  expect(sent.some((message) => message.content.includes("x".repeat(100)))).toBe(false)
})
