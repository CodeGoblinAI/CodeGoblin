import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Global } from "../src/platform/paths"
import { History } from "../src/core/undo"
import { create, load, save } from "../src/core/sessions"
import { requireSandbox } from "./sandbox"

async function workspace() {
  requireSandbox(path.join(Global.Path.home, "undo-persist-fixture"), "persistent undo tests")
  return fs.mkdtemp(path.join(Global.Path.home, "undo-persist-"))
}
const read = (root: string, file: string) => fs.readFile(path.join(root, file), "utf8").catch(() => null)

/** A turn that writes `files` (path -> new content), committed the way the surfaces commit. */
async function turn(history: History, root: string, label: string, files: Record<string, string>) {
  history.begin(label)
  for (const [file, content] of Object.entries(files)) {
    await history.record(root, file)
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true })
    await fs.writeFile(path.join(root, file), content)
  }
  history.commit(root)
}

/** Saved with a conversation and read back, as a restart or /resume does. */
async function afterRestart(history: History, root: string): Promise<History> {
  const session = create("fixture", "fixture")
  session.review = history.reviewState(root)
  await save(session)
  const restored = new History()
  restored.restoreReview(root, (await load(session.id))!.review)
  return restored
}

test("undo and redo work after a restart, newest turn first", async () => {
  const root = await workspace()
  await fs.writeFile(path.join(root, "a.txt"), "one\n")
  const history = new History()
  await turn(history, root, "first", { "a.txt": "two\n" })
  await turn(history, root, "second", { "a.txt": "three\n", "new/b.txt": "made\n" })

  const restored = await afterRestart(history, root)
  expect(restored.canUndo()).toBe(true)
  expect((await restored.undo(root))?.label).toBe("second")
  expect(await read(root, "a.txt")).toBe("two\n")
  expect(await read(root, "new/b.txt")).toBeNull()
  // The folder the turn created goes with its file.
  expect(await fs.stat(path.join(root, "new")).catch(() => null)).toBeNull()

  // And redo survives another restart.
  const again = await afterRestart(restored, root)
  expect((await again.redo(root))?.label).toBe("second")
  expect(await read(root, "a.txt")).toBe("three\n")
  expect(await read(root, "new/b.txt")).toBe("made\n")
  expect((await again.undo(root))?.label).toBe("second")
  expect((await again.undo(root))?.label).toBe("first")
  expect(await read(root, "a.txt")).toBe("one\n")
})

test("a file edited since the turn is never overwritten: undo refuses and leaves everything as it was", async () => {
  const root = await workspace()
  await fs.writeFile(path.join(root, "a.txt"), "before\n")
  await fs.writeFile(path.join(root, "c.txt"), "c before\n")
  const history = new History()
  await turn(history, root, "edit both", { "a.txt": "model\n", "c.txt": "c model\n" })
  const restored = await afterRestart(history, root)
  // The person changes one file by hand after the turn.
  await fs.writeFile(path.join(root, "c.txt"), "my own edit\n")
  await expect(restored.undo(root)).rejects.toThrow("c.txt changed since that turn")
  // Nothing was put back - not even the untouched file - and the checkpoint is still there.
  expect(await read(root, "a.txt")).toBe("model\n")
  expect(await read(root, "c.txt")).toBe("my own edit\n")
  expect(restored.canUndo()).toBe(true)
  // Put the file back as the turn left it, and undo works.
  await fs.writeFile(path.join(root, "c.txt"), "c model\n")
  expect((await restored.undo(root))?.label).toBe("edit both")
  expect(await read(root, "c.txt")).toBe("c before\n")
})

test("the same protection holds without a restart", async () => {
  const root = await workspace()
  await fs.writeFile(path.join(root, "a.txt"), "before\n")
  const history = new History()
  await turn(history, root, "edit", { "a.txt": "model\n" })
  await fs.writeFile(path.join(root, "a.txt"), "hand edit\n")
  await expect(history.undo(root)).rejects.toThrow("changed since that turn")
  expect(await read(root, "a.txt")).toBe("hand edit\n")
})

test("only what fits is saved, newest first, and tampered history is not trusted", async () => {
  const root = await workspace()
  const history = new History()
  await turn(history, root, "small old", { "s.txt": "x" })
  await fs.writeFile(path.join(root, "big.txt"), "y".repeat(600 * 1024))
  await turn(history, root, "big", { "big.txt": "z" })
  await turn(history, root, "small new", { "t.txt": "x" })
  const saved = history.reviewState(root)
  // The big file's checkpoint cannot be saved, and nothing older than it can be undone without it.
  expect(saved.checkpoints?.done.map((c) => c.label)).toEqual(["small new"])

  const tampered = structuredClone(saved)
  tampered.checkpoints!.done[0]!.files[0]!.path = "../outside.txt"
  const restored = new History()
  restored.restoreReview(root, tampered)
  expect(restored.canUndo()).toBe(false)
  expect(restored.reviewNotice).toContain("undo history was invalid")

  const badHash = structuredClone(saved)
  badHash.checkpoints!.done[0]!.after = ["not-a-hash"]
  const second = new History()
  second.restoreReview(root, badHash)
  expect(second.canUndo()).toBe(false)
})
