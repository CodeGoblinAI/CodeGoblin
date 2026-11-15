import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import fsSync from "node:fs"
import path from "node:path"
import { Global } from "../src/platform/paths"
import { History, nothingToDo } from "../src/core/undo"
import { changesIn } from "../src/core/changes"
import { create, load, save } from "../src/core/sessions"
import { normaliseActivity, recordActivity } from "../src/core/session-activity"
import { requireSandbox } from "./sandbox"

async function workspace() {
  requireSandbox(path.join(Global.Path.home, "review-fixture"), "session review tests")
  return fs.mkdtemp(path.join(Global.Path.home, "review-"))
}

test("saved baselines survive a new process; a checkpoint with no record of how its turn ended is not restored", async () => {
  const root = await workspace()
  await fs.writeFile(path.join(root, "example.txt"), "before\n")
  const original = new History()
  original.begin("change")
  await original.record(root, "example.txt")
  await fs.writeFile(path.join(root, "example.txt"), "after\n")
  original.commit()
  const session = create("fixture", "fixture")
  session.review = original.reviewState(root)
  session.activity = normaliseActivity(undefined)
  recordActivity(session.activity, { type: "tool_start", id: "edit", name: "edit_file", args: '{"path":"example.txt","old_string":"before","new_string":"after"}' })
  recordActivity(session.activity, { type: "tool_end", id: "edit", name: "edit_file", result: "edited +1 -1" })
  await save(session)
  const restoredSession = (await load(session.id))!
  const restored = new History()
  restored.restoreReview(root, restoredSession.review)
  expect(await changesIn(root, restored)).toEqual(await changesIn(root, original))
  expect(restored.canUndo()).toBe(false)
  expect(nothingToDo(restored, false)).toContain("/diff shows what this session changed")
  expect(restoredSession.activity?.items[0]).toMatchObject({ state: "done" })
  expect(restoredSession.activity?.items[0]?.label).toContain("edit_file · example.txt")
})

test("a saved baseline cannot be applied to a different root or an escaping path", async () => {
  const root = await workspace()
  const other = await workspace()
  // A root is saved by where it really is: on macOS a temporary folder is reached through a link (/var -> /private/var).
  const real = fsSync.realpathSync(root)
  const valid = { root: process.platform === "win32" ? real.toLowerCase() : real, files: [{ path: "inside.txt", before: "old" }] }
  const wrongRoot = new History()
  wrongRoot.restoreReview(other, valid)
  expect(wrongRoot.origins().size).toBe(0)
  expect(wrongRoot.reviewNotice).toContain("unavailable")
  const escape = new History()
  escape.restoreReview(root, { ...valid, files: [{ path: "../outside.txt", before: "private" }] })
  expect(escape.origins().size).toBe(0)
  expect(escape.reviewNotice).toContain("outside")
})

test("oversized saved baselines are bounded and visibly incomplete, never silently trusted", async () => {
  const root = await workspace()
  await fs.writeFile(path.join(root, "large.txt"), "x".repeat(300000))
  const history = new History()
  history.begin("large")
  await history.record(root, "large.txt")
  const saved = history.reviewState(root)
  expect(saved.files).toEqual([])
  expect(saved.truncated).toBe(true)
  const restored = new History()
  restored.restoreReview(root, saved)
  expect(restored.reviewNotice).toContain("incomplete")
  restored.restoreReview(root, { ...saved, files: [{ path: "large.txt", before: "x".repeat(300000) }] })
  expect(restored.origins().size).toBe(0)
  expect(restored.reviewNotice).toContain("limits")
})

test("activity is bounded, denials stay failed, pending restore is not falsely running/done, and plan survives", () => {
  const activity = normaliseActivity(undefined)
  for (let index = 0; index < 105; index++) recordActivity(activity, { type: "tool_start", id: String(index), name: "read_file", args: '{"path":"notes.txt"}' })
  recordActivity(activity, { type: "tool_denied", id: "104", name: "read_file", by: "user" })
  recordActivity(activity, { type: "tool_end", id: "104", name: "read_file", result: "Refused by user" })
  recordActivity(activity, { type: "plan", todos: [{ content: "Look", status: "pending" }] })
  const resumed = normaliseActivity(activity, true)
  expect(resumed.items).toHaveLength(100)
  expect(resumed.items.at(-1)?.state).toBe("failed")
  expect(resumed.items[0]?.state).toBe("interrupted")
  expect(resumed.plan).toEqual([{ content: "Look", status: "pending" }])
  expect(normaliseActivity({ items: [null, { id: "bad", state: "fake" }], plan: null })).toEqual({ items: [], plan: [] })
})
