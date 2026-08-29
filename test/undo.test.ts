import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { History, describe as describeCheckpoint, nothingToDo } from "../src/core/undo"

const NEWLINE = String.fromCharCode(10)

async function scratch() {
  const root = path.join(os.tmpdir(), "cg-undo-" + Math.random().toString(36).slice(2))
  await fs.mkdir(root, { recursive: true })
  return root
}

const read = (root: string, name: string) => fs.readFile(path.join(root, name), "utf8").catch(() => null)

describe("taking back a turn", () => {
  test("puts an edited file back the way it was", async () => {
    const root = await scratch()
    await fs.writeFile(path.join(root, "a.ts"), "original", "utf8")

    const history = new History()
    history.begin("edit a")
    await history.record(root, "a.ts")
    await fs.writeFile(path.join(root, "a.ts"), "changed", "utf8")
    history.commit()

    expect(await read(root, "a.ts")).toBe("changed")
    await history.undo(root)
    expect(await read(root, "a.ts")).toBe("original")
  })

  test("removes a file the turn created, rather than leaving it empty", async () => {
    const root = await scratch()
    const history = new History()
    history.begin("create b")
    await history.record(root, "b.ts")
    await fs.writeFile(path.join(root, "b.ts"), "new file", "utf8")
    history.commit()

    await history.undo(root)
    expect(await read(root, "b.ts")).toBeNull()
  })

  test("undoes to how the turn started, not to its second edit", async () => {
    const root = await scratch()
    await fs.writeFile(path.join(root, "c.ts"), "first", "utf8")

    const history = new History()
    history.begin("edit c twice")
    await history.record(root, "c.ts")
    await fs.writeFile(path.join(root, "c.ts"), "second", "utf8")
    await history.record(root, "c.ts")
    await fs.writeFile(path.join(root, "c.ts"), "third", "utf8")
    history.commit()

    await history.undo(root)
    expect(await read(root, "c.ts")).toBe("first")
  })

  test("restores every file a turn touched", async () => {
    const root = await scratch()
    await fs.writeFile(path.join(root, "d.ts"), "d1", "utf8")
    await fs.writeFile(path.join(root, "e.ts"), "e1", "utf8")

    const history = new History()
    history.begin("edit both")
    await history.record(root, "d.ts")
    await history.record(root, "e.ts")
    await fs.writeFile(path.join(root, "d.ts"), "d2", "utf8")
    await fs.writeFile(path.join(root, "e.ts"), "e2", "utf8")
    history.commit()

    await history.undo(root)
    expect([await read(root, "d.ts"), await read(root, "e.ts")]).toEqual(["d1", "e1"])
  })

  test("writes into a directory the undo had removed", async () => {
    const root = await scratch()
    const history = new History()
    history.begin("nested")
    await history.record(root, "deep/nested/f.ts")
    await fs.mkdir(path.join(root, "deep", "nested"), { recursive: true })
    await fs.writeFile(path.join(root, "deep", "nested", "f.ts"), "made", "utf8")
    history.commit()

    await history.undo(root)
    expect(await read(root, "deep/nested/f.ts")).toBeNull()
    await history.redo(root)
    expect(await read(root, "deep/nested/f.ts")).toBe("made")
  })
})

describe("redo", () => {
  test("puts back what undo took away", async () => {
    const root = await scratch()
    await fs.writeFile(path.join(root, "g.ts"), "before", "utf8")

    const history = new History()
    history.begin("edit g")
    await history.record(root, "g.ts")
    await fs.writeFile(path.join(root, "g.ts"), "after", "utf8")
    history.commit()

    await history.undo(root)
    expect(await read(root, "g.ts")).toBe("before")
    await history.redo(root)
    expect(await read(root, "g.ts")).toBe("after")
  })

  test("is forgotten once new work is committed", async () => {
    const root = await scratch()
    const history = new History()
    history.begin("one")
    await history.record(root, "h.ts")
    await fs.writeFile(path.join(root, "h.ts"), "one", "utf8")
    history.commit()
    await history.undo(root)
    expect(history.canRedo()).toBe(true)

    history.begin("two")
    await history.record(root, "i.ts")
    await fs.writeFile(path.join(root, "i.ts"), "two", "utf8")
    history.commit()
    expect(history.canRedo()).toBe(false)
  })
})

describe("what is worth keeping", () => {
  test("a turn that wrote nothing leaves nothing to undo", async () => {
    const root = await scratch()
    const history = new History()
    history.begin("just talking")
    history.commit()
    expect(history.canUndo()).toBe(false)
    expect(await history.undo(root)).toBeUndefined()
  })

  test("recording outside a turn is ignored rather than throwing", async () => {
    const root = await scratch()
    const history = new History()
    await history.record(root, "j.ts")
    expect(history.canUndo()).toBe(false)
  })

  test("keeps the most recent turns and drops the oldest", async () => {
    const root = await scratch()
    const history = new History()
    for (let n = 0; n < 25; n++) {
      history.begin("turn " + n)
      await history.record(root, "k" + n + ".ts")
      await fs.writeFile(path.join(root, "k" + n + ".ts"), String(n), "utf8")
      history.commit()
    }
    // 20 kept: undoing 20 times empties it, and the oldest five are gone for good.
    for (let n = 0; n < 20; n++) expect(await history.undo(root)).toBeDefined()
    expect(history.canUndo()).toBe(false)
    expect(await read(root, "k0.ts")).toBe("0")
    expect(await read(root, "k24.ts")).toBeNull()
  })

  test("never captures a path outside the working directory", async () => {
    const root = await scratch()
    const history = new History()
    history.begin("escape attempt")
    await history.record(root, "../../outside.ts")
    await history.record(root, "ok.ts")
    await fs.writeFile(path.join(root, "ok.ts"), "fine", "utf8")
    history.commit()

    // The escaping path is simply not in the checkpoint, so undoing restores
    // what it can instead of throwing part way through.
    const checkpoint = await history.undo(root)
    expect(checkpoint?.files.map((snapshot) => snapshot.path)).toEqual(["ok.ts"])
    expect(await read(root, "ok.ts")).toBeNull()
  })
})

describe("describing a checkpoint", () => {
  test("names the files, and counts the rest", () => {
    const many = { label: "x", files: "abcde".split("").map((n) => ({ path: n + ".ts", before: null })) }
    expect(describeCheckpoint(many)).toBe("5 files (a.ts, b.ts, c.ts, +2 more)")
    expect(describeCheckpoint({ label: "x", files: [{ path: "solo.ts", before: null }] })).toBe("1 file (solo.ts)")
  })
})

describe("saying why there was nothing to do", () => {
  test("tells apart a session that changed nothing from one already back at the start", async () => {
    const root = await scratch()
    const history = new History()
    expect(nothingToDo(history, false)).toContain("no file has been changed")
    expect(nothingToDo(history, true)).toBe("nothing to redo")

    history.begin("a turn")
    await history.record(root, "z.ts")
    await fs.writeFile(path.join(root, "z.ts"), "written", "utf8")
    history.commit()
    await history.undo(root)

    expect(nothingToDo(history, false)).toContain("already back to how this session started")
  })
})
