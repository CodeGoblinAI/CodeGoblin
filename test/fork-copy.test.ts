import { expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { Global } from "../src/platform/paths"
import * as sessions from "../src/core/sessions"
import { runCommand } from "../src/core/commands"

test("/fork saves a separate copy to carry on in; the original is untouched", async () => {
  const original = sessions.create("deepseek", "deepseek-chat")
  original.title = "Fix the parser"
  original.messages = [{ role: "system", content: "sys" }, { role: "user", content: "fix it" }, { role: "assistant", content: "done" }]
  original.spend = { input: 10, output: 5 }
  await sessions.save(original)
  await sessions.appendArchive(original.id, [{ role: "user", content: "compacted away" }])
  const before = fs.readFileSync(path.join(Global.Path.state, "sessions", original.id + ".json"), "utf8")

  const copy = await sessions.fork(original)
  copy.messages.push({ role: "user", content: "try another way" })
  expect(copy.id).not.toBe(original.id)
  expect(copy.title).toBe("Fork: Fix the parser")
  expect(copy.forkedFrom?.id).toBe(original.id)
  expect(copy.spend).toBeUndefined()
  expect(original.messages).toHaveLength(3)
  expect(fs.readFileSync(path.join(Global.Path.state, "sessions", original.id + ".json"), "utf8")).toBe(before)
  expect(await sessions.hasArchive(copy.id)).toBe(true)
  expect((await sessions.load(copy.id))?.messages).toHaveLength(3)
  // Forking a fork does not stack the prefix.
  expect((await sessions.fork(copy)).title).toBe("Fork: Fix the parser")
})

test("a conversation is titled by its first real prompt, not a ! command typed before it", () => {
  expect(sessions.titleFrom([{ role: "user", content: "ran it", display: "! git status\n\nM app.js", typed: true }])).toBe("New session")
  expect(sessions.titleFrom([{ role: "user", content: "ran it", display: "! git status", typed: true }, { role: "user", content: "fix the failing test" }])).toBe("fix the failing test")
})

test("/copy takes the last answer with words in it", () => {
  expect(sessions.lastAnswer([{ role: "assistant", content: "first" }, { role: "user", content: "q" }, { role: "assistant", content: "second" }, { role: "assistant", content: "  " }])).toBe("second")
  expect(sessions.lastAnswer([{ role: "user", content: "only a question" }])).toBeUndefined()
  expect(runCommand("/fork")).toEqual({ kind: "fork" })
  expect(runCommand("/copy last")).toEqual({ kind: "copy", what: "last" })
})

test("/copy alone copies the whole conversation, like the fork's; anything else gets its usage", () => {
  expect(runCommand("/copy")).toEqual({ kind: "copy", what: "all" })
  expect(runCommand("/copy all")).toEqual({ kind: "copy", what: "all" })
  expect(runCommand("/copy everything")).toMatchObject({ kind: "message" })
})
