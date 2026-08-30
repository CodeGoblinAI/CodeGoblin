import { expect, test, describe } from "bun:test"
import { diffFile, countsOf, statusLetter, toUnified, byImpact } from "../src/core/diff"

const NL = String.fromCharCode(10)
const lines = (...rows: string[]) => rows.join(NL) + NL

describe("what changed", () => {
  test("an unchanged file has no hunks and says so", () => {
    const diff = diffFile("a.ts", lines("one", "two"), lines("one", "two"))
    expect(diff.status).toBe("unchanged")
    expect(diff.hunks).toEqual([])
    expect(countsOf(diff)).toBe("no change")
  })

  test("a one-line edit is one add and one remove", () => {
    const diff = diffFile("a.ts", lines("one", "two", "three"), lines("one", "TWO", "three"))
    expect(diff.status).toBe("modified")
    expect(diff.added).toBe(1)
    expect(diff.removed).toBe(1)
    expect(countsOf(diff)).toBe("+1 -1")
  })

  test("a new file is every line added, and nothing removed", () => {
    const diff = diffFile("new.ts", null, lines("one", "two"))
    expect(diff.status).toBe("added")
    expect(diff.added).toBe(2)
    expect(diff.removed).toBe(0)
    expect(statusLetter(diff)).toBe("A")
  })

  test("a deleted file is every line removed", () => {
    const diff = diffFile("gone.ts", lines("one", "two"), null)
    expect(diff.status).toBe("removed")
    expect(diff.removed).toBe(2)
    expect(statusLetter(diff)).toBe("D")
  })

  test("a trailing newline does not invent an empty last line", () => {
    expect(diffFile("a.ts", "one" + NL, "one" + NL).status).toBe("unchanged")
    expect(diffFile("a.ts", "one", "one" + NL).added).toBe(0)
  })

  test("an insertion is an add with no matching remove", () => {
    const diff = diffFile("a.ts", lines("one", "three"), lines("one", "two", "three"))
    expect(diff.added).toBe(1)
    expect(diff.removed).toBe(0)
    expect(countsOf(diff)).toBe("+1")
  })
})

describe("hunks", () => {
  test("the unchanged middle of a file is left out", () => {
    const before = lines(...Array.from({ length: 40 }, (_, i) => "line " + i))
    const after = before.replace("line 0" + NL, "CHANGED" + NL).replace("line 39" + NL, "ALSO" + NL)
    const diff = diffFile("a.ts", before, after)
    expect(diff.hunks.length).toBe(2)
    // Two edits 39 lines apart, three lines of context: nowhere near the whole file.
    const shown = diff.hunks.reduce((total, hunk) => total + hunk.lines.length, 0)
    expect(shown).toBeLessThan(20)
  })

  test("edits close together become one hunk, not two with a gap", () => {
    const before = lines(...Array.from({ length: 20 }, (_, i) => "line " + i))
    const after = before.replace("line 5" + NL, "X" + NL).replace("line 7" + NL, "Y" + NL)
    expect(diffFile("a.ts", before, after).hunks.length).toBe(1)
  })

  test("a hunk header counts the lines it actually holds", () => {
    const diff = diffFile("a.ts", lines("a", "b", "c"), lines("a", "B", "c"))
    const [hunk] = diff.hunks
    expect(hunk.beforeStart).toBe(1)
    expect(hunk.afterStart).toBe(1)
    expect(hunk.beforeCount).toBe(3)
    expect(hunk.afterCount).toBe(3)
  })

  test("context can be turned off", () => {
    const diff = diffFile("a.ts", lines("a", "b", "c"), lines("a", "B", "c"), 0)
    expect(diff.hunks[0].lines.every((line) => line.kind !== "context")).toBe(true)
  })
})

describe("line numbers", () => {
  test("a context line carries both sides, an add only the after", () => {
    const diff = diffFile("a.ts", lines("one", "two"), lines("one", "1.5", "two"))
    const all = diff.hunks.flatMap((hunk) => hunk.lines)
    const added = all.find((line) => line.kind === "add")!
    expect(added.after).toBe(2)
    expect(added.before).toBeUndefined()
    const context = all.find((line) => line.kind === "context")!
    expect(context.before).toBe(1)
    expect(context.after).toBe(1)
  })
})

describe("guards", () => {
  test("a huge rewrite is reported rather than ground through", () => {
    // Quadratic in the differing region, so a wholesale rewrite of a big file
    // has to stop rather than sit there allocating.
    const before = lines(...Array.from({ length: 4000 }, (_, i) => "old " + i))
    const after = lines(...Array.from({ length: 4000 }, (_, i) => "new " + i))
    const started = Date.now()
    const diff = diffFile("big.ts", before, after)
    expect(diff.truncated).toBe(true)
    expect(diff.added).toBe(4000)
    expect(diff.removed).toBe(4000)
    expect(Date.now() - started).toBeLessThan(4000)
  })

  test("two empty files are unchanged, not a crash", () => {
    expect(diffFile("a.ts", "", "").status).toBe("unchanged")
  })

  test("an empty file gaining content is an ordinary add", () => {
    expect(diffFile("a.ts", "", lines("one")).added).toBe(1)
  })
})

describe("output", () => {
  test("a patch reads as a patch", () => {
    const patch = toUnified(diffFile("a.ts", lines("one", "two"), lines("one", "TWO")))
    expect(patch).toContain("--- a/a.ts")
    expect(patch).toContain("+++ b/a.ts")
    expect(patch).toContain("@@ -1,2 +1,2 @@")
    expect(patch).toContain("-two")
    expect(patch).toContain("+TWO")
  })

  test("a new file diffs against nothing", () => {
    expect(toUnified(diffFile("new.ts", null, lines("one")))).toContain("--- /dev/null")
  })

  test("a deleted file diffs to nothing", () => {
    expect(toUnified(diffFile("gone.ts", lines("one"), null))).toContain("+++ /dev/null")
  })

  test("the biggest change is listed first", () => {
    const small = diffFile("small.ts", lines("a"), lines("b"))
    const big = diffFile("big.ts", lines("a", "b", "c"), lines("x", "y", "z"))
    expect(byImpact([small, big]).map((d) => d.path)).toEqual(["big.ts", "small.ts"])
  })
})
