import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import { readFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { findMention, mentionPaths, expandMentions } from "../src/core/mention"

describe("finding the mention under the caret", () => {
  test("finds one being typed at the end", () => {
    expect(findMention("look at @src/core", 17)).toEqual({ start: 8, end: 17, query: "src/core" })
  })

  test("finds a bare @ so the picker opens before anything is typed", () => {
    expect(findMention("@", 1)).toEqual({ start: 0, end: 1, query: "" })
  })

  test("replaces the whole token when completing from the middle", () => {
    // caret after "@src/co", token runs to "re/tools.ts"
    const found = findMention("@src/core/tools.ts", 7)
    expect(found).toEqual({ start: 0, end: 18, query: "src/co" })
  })

  test("ignores an @ that does not open a word", () => {
    expect(findMention("mail shawn@example.com", 22)).toBeUndefined()
  })

  test("ignores a caret that has moved off the token", () => {
    expect(findMention("@src/core and more", 18)).toBeUndefined()
  })

  test("has nothing to find in ordinary text", () => {
    expect(findMention("hello there", 11)).toBeUndefined()
  })
})

describe("collecting mentions from a message", () => {
  test("takes each one once, in order", () => {
    expect(mentionPaths("diff @a.ts against @b.ts and @a.ts")).toEqual(["a.ts", "b.ts"])
  })

  test("drops punctuation that ends a sentence, not the extension", () => {
    expect(mentionPaths("read @src/core/tools.ts, then @README.")).toEqual(["src/core/tools.ts", "README"])
  })

  test("leaves email addresses and npm scopes alone", () => {
    expect(mentionPaths("mail shawn@example.com about @types/node")).toEqual(["types/node"])
  })
})

describe("expanding mentions", () => {
  const root = path.join(os.tmpdir(), "cg-mention-" + Math.random().toString(36).slice(2))

  test("attaches the file the message mentions", async () => {
    await fs.mkdir(path.join(root, "src"), { recursive: true })
    await fs.writeFile(path.join(root, "src", "hello.ts"), "export const hello = 1", "utf8")

    const result = await expandMentions("explain @src/hello.ts", root)
    expect(result.files).toEqual(["src/hello.ts"])
    expect(result.content).toContain("explain @src/hello.ts")
    expect(result.content).toContain("export const hello = 1")
  })

  test("leaves a mention that resolves to nothing exactly as typed", async () => {
    const result = await expandMentions("what about @not/a/file.ts", root)
    expect(result.files).toEqual([])
    expect(result.content).toBe("what about @not/a/file.ts")
  })

  test("refuses to read its way out of the working directory", async () => {
    const result = await expandMentions("read @../../../etc/passwd", root)
    expect(result.files).toEqual([])
    expect(result.content).toBe("read @../../../etc/passwd")
  })

  test("ignores a directory, which has no contents to attach", async () => {
    const result = await expandMentions("look in @src", root)
    expect(result.files).toEqual([])
  })

  test("passes ordinary text through untouched", async () => {
    const result = await expandMentions("no mentions here", root)
    expect(result.content).toBe("no mentions here")
    expect(result.files).toEqual([])
    expect(result.images).toEqual([])
  })
})

describe("mentioning a picture", () => {
  const root = path.join(os.tmpdir(), "cg-mention-img-" + Math.random().toString(36).slice(2))

  /** The smallest real PNG: 1x1, so these stay about the plumbing. */
  const PNG = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  )

  test("an image is attached as an image, not read as text", async () => {
    await fs.mkdir(root, { recursive: true })
    await fs.writeFile(path.join(root, "shot.png"), PNG)

    const result = await expandMentions("what is in @shot.png", root)

    expect(result.images).toHaveLength(1)
    expect(result.images[0]!.name).toBe("shot.png")
    expect(result.images[0]!.dataUrl.startsWith("data:image/png;base64,")).toBe(true)
    // It counts as attached, and its bytes never land in the prompt.
    expect(result.files).toEqual(["shot.png"])
    expect(result.content).toBe("what is in @shot.png")
  })

  test("the type comes from the extension, whatever its case", async () => {
    await fs.mkdir(root, { recursive: true })
    await fs.writeFile(path.join(root, "Photo.JPG"), PNG)

    const result = await expandMentions("describe @Photo.JPG", root)
    expect(result.images[0]!.dataUrl.startsWith("data:image/jpeg;base64,")).toBe(true)
  })

  test("text and pictures in one message each go where they belong", async () => {
    await fs.mkdir(root, { recursive: true })
    await fs.writeFile(path.join(root, "notes.txt"), "some notes", "utf8")
    await fs.writeFile(path.join(root, "shot.png"), PNG)

    const result = await expandMentions("compare @notes.txt and @shot.png", root)
    expect(result.content).toContain("some notes")
    expect(result.images.map((image) => image.name)).toEqual(["shot.png"])
  })

  test("an image too large to send says so instead of being dropped", async () => {
    await fs.mkdir(root, { recursive: true })
    await fs.writeFile(path.join(root, "huge.png"), Buffer.alloc(6_000_000))

    const result = await expandMentions("look at @huge.png", root)
    expect(result.images).toEqual([])
    // Silence would read as "there is nothing here", which is a different fact.
    expect(result.content).toContain("huge.png")
    expect(result.content).toContain("over the limit")
  })

  test("a file that only looks like a picture is not forced into one", async () => {
    await fs.mkdir(root, { recursive: true })
    await fs.writeFile(path.join(root, "readme.md"), "# not a picture", "utf8")

    const result = await expandMentions("read @readme.md", root)
    expect(result.images).toEqual([])
    expect(result.content).toContain("# not a picture")
  })
})

describe("the browser's copy of the mention rules", () => {
  // app.js is served to the browser as a plain script, so it cannot import
  // findMention and keeps its own copy. Run both against the same cases: a
  // copy that drifts - or gets its escape sequences mangled in transit, which
  // has happened - fails here rather than in someone's composer.
  const source = readFileSync(path.join(import.meta.dir, "../src/web/app.js"), "utf8")
  const slice = source.slice(source.indexOf("const MENTION_SPACE"), source.indexOf("function rankFiles"))
  const browserFindMention = new Function(slice + "; return findMention")() as typeof findMention

  const TAB = String.fromCharCode(9)
  const LF = String.fromCharCode(10)

  const cases: [string, number][] = [
    ["explain @src/core", 17],
    ["@", 1],
    ["@src/core/tools.ts", 7],
    ["mail shawn@example.com", 22],
    ["@src/core and more", 18],
    ["hello there", 11],
    ["read" + TAB + "@a.ts", 10],
    ["first line" + LF + "@b.ts", 16],
    ["@a.ts @b.ts", 11],
    ["", 0],
    ["@x", 99],
  ]

  test("agrees with the original on every case", () => {
    expect(slice.length).toBeGreaterThan(100)
    for (const [text, cursor] of cases) {
      expect([text, cursor, browserFindMention(text, cursor)]).toEqual([text, cursor, findMention(text, cursor)])
    }
  })
})
