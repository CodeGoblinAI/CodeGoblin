import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { appendArchive, create, displayWindow, hasArchive, loadArchive, remove, save } from "../src/core/sessions"
import { boundSummaryInput, estimateTokens } from "../src/core/context"
import { exportSession } from "../src/core/export"
import { Global } from "../src/platform/paths"
import type { Message } from "../src/core/agent"
import { requireSandbox } from "./sandbox"

const chat = (count: number): Message[] =>
  Array.from({ length: count }, (_, index): Message => index % 2 ? { role: "assistant", content: "reply " + index } : { role: "user", content: "ask " + index })

test("a long conversation is drawn from its recent end and says how much is left out", () => {
  const messages: Message[] = [{ role: "system", content: "sys" }, ...chat(500)]
  const shown = displayWindow(messages, 200)
  expect(shown.messages.length).toBe(200)
  expect(shown.messages.at(-1)?.content).toBe("reply 499")
  expect(shown.hidden).toBe(300)
  // Short conversations come back untouched.
  expect(displayWindow(chat(10), 200)).toEqual({ messages: chat(10), hidden: 0 })
})

test("the drawn window keeps an answer together with the tool calls that led to it", () => {
  const messages: Message[] = [
    ...chat(4),
    { role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "read_file", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "c1", content: "file text" },
    { role: "assistant", content: "done" },
  ]
  const shown = displayWindow(messages, 1)
  // The call, its result and the answer come as one; nothing opens on a bare result.
  expect(shown.messages.map((m) => m.role)).toEqual(["assistant", "tool", "assistant"])
  expect(shown.messages[0]!.tool_calls?.[0]?.id).toBe("c1")
  expect(shown.hidden).toBe(4)
})

test("a summary request carries only what fits, keeping an earlier summary", () => {
  const earlier: Message = { role: "user", content: "Summary of earlier conversation:\nolder work" }
  const long = [earlier, ...Array.from({ length: 400 }, (_, index): Message => ({ role: "user", content: "x".repeat(400) + index }))]
  const window = 10_000
  const bounded = boundSummaryInput(long, window)
  expect(bounded.omitted).toBeGreaterThan(0)
  expect(bounded.messages[0]).toBe(earlier)
  expect(bounded.messages[1]!.content).toContain(bounded.omitted + " earlier messages are kept in the saved transcript")
  expect(bounded.messages.at(-1)!.content.endsWith("399")).toBe(true)
  const tokens = bounded.messages.reduce((sum, message) => sum + estimateTokens(message.content), 0)
  expect(tokens).toBeLessThan(window * 0.6)
  // Something that already fits is sent as it is.
  expect(boundSummaryInput(chat(6), window)).toEqual({ messages: chat(6), omitted: 0 })
})

test("compacted messages are archived and the export keeps every word", async () => {
  const session = create("deepseek")
  requireSandbox(path.join(Global.Path.state, "sessions", session.id + ".json"), "long conversation tests")
  session.messages = [{ role: "user", content: "Summary of earlier conversation:\nshort version" }, { role: "assistant", content: "newest reply" }]
  await save(session)
  expect(await hasArchive(session.id)).toBe(false)
  await appendArchive(session.id, [{ role: "user", content: "first ever question" }])
  await appendArchive(session.id, [{ role: "assistant", content: "first ever answer" }])
  expect((await loadArchive(session.id)).map((m) => m.content)).toEqual(["first ever question", "first ever answer"])
  expect(await hasArchive(session.id)).toBe(true)

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cgn-export-"))
  const written = await exportSession(session, dir, Date.now(), "chat.md")
  const markdown = await fs.readFile(path.resolve(dir, written), "utf8")
  expect(markdown.indexOf("first ever question")).toBeLessThan(markdown.indexOf("compacted here"))
  expect(markdown.indexOf("compacted here")).toBeLessThan(markdown.indexOf("newest reply"))

  // Deleting the conversation takes its archive with it.
  expect(await remove(session.id)).toBe(true)
  expect(await hasArchive(session.id)).toBe(false)
})
