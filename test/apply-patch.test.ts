import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { parsePatch, planPatch } from "../src/core/patch"
import { runTool } from "../src/core/tools"
import { runAgent, usesPatch, type Message } from "../src/core/agent"
import { Permissions, askedFor } from "../src/core/permission"
import { History } from "../src/core/undo"
import type { Provider } from "../src/core/providers"

const NEWLINE = String.fromCharCode(10)
const project = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cg-patch-"))
  fs.writeFileSync(path.join(root, "app.py"), ["def greet():", '    print("Hi")', "", "def other():", "    return 1", ""].join(NEWLINE))
  fs.writeFileSync(path.join(root, "old.txt"), "obsolete\n")
  return root
}
const patch = (...lines: string[]) => ["*** Begin Patch", ...lines, "*** End Patch"].join(NEWLINE)

describe("apply_patch", () => {
  test("adds, updates with context, moves and deletes in one go", async () => {
    const root = project()
    const result = await runTool("apply_patch", { patch: patch(
      "*** Add File: docs/hello.txt", "+Hello world",
      "*** Update File: app.py", "*** Move to: main.py", "@@ def greet():", '-    print("Hi")', '+    print("Hello, world!")',
      "*** Delete File: old.txt",
    ) }, root)
    expect(result).toBe("added docs/hello.txt\nmoved app.py to main.py\ndeleted old.txt")
    expect(fs.readFileSync(path.join(root, "docs", "hello.txt"), "utf8")).toBe("Hello world\n")
    expect(fs.readFileSync(path.join(root, "main.py"), "utf8")).toContain('print("Hello, world!")')
    expect(fs.existsSync(path.join(root, "app.py"))).toBe(false)
    expect(fs.existsSync(path.join(root, "old.txt"))).toBe(false)
  })

  test("one hunk that does not match, and nothing is written", async () => {
    const root = project()
    const result = await runTool("apply_patch", { patch: patch(
      "*** Add File: new.txt", "+fresh",
      "*** Update File: app.py", "@@", "-    return 2", "+    return 3",
    ) }, root)
    expect(result).toContain("does not match the file")
    expect(result).toContain("nothing was changed")
    expect(fs.existsSync(path.join(root, "new.txt"))).toBe(false)
  })

  test("never reaches outside the working directory", async () => {
    const root = project()
    expect(await runTool("apply_patch", { patch: patch("*** Add File: ../escape.txt", "+x") }, root)).toContain("escapes the working directory")
  })

  test("bad patches are refused with a reason", () => {
    expect(() => parsePatch("no envelope")).toThrow("Begin Patch")
    expect(() => parsePatch("*** Begin Patch\n*** Add File: a\nnot plus\n*** End Patch")).toThrow("starts with +")
    expect(() => parsePatch("*** Begin Patch\n*** Add File: a\n+x")).toThrow("End Patch")
    expect(() => planPatch(project(), parsePatch(patch("*** Add File: app.py", "+x")))).toThrow("already exists")
  })

  test("/undo puts every file back, deleted ones included", async () => {
    const root = project()
    const history = new History()
    history.begin("patch")
    await runTool("apply_patch", { patch: patch("*** Delete File: old.txt", "*** Update File: app.py", "-    return 1", "+    return 2") }, root, (relative) => history.record(root, relative))
    history.commit(root)
    await history.undo(root)
    expect(fs.readFileSync(path.join(root, "old.txt"), "utf8")).toBe("obsolete\n")
    expect(fs.readFileSync(path.join(root, "app.py"), "utf8")).toContain("return 1")
  })
})

describe("who gets it, and what it asks", () => {
  test("GPT-5-era and Codex models, as in the fork; not gpt-oss, GPT-4 or others", () => {
    expect(usesPatch("gpt-5.2-codex")).toBe(true)
    expect(usesPatch("gpt-5.1")).toBe(true)
    expect(usesPatch("gpt-oss-120b")).toBe(false)
    expect(usesPatch("gpt-4.1")).toBe(false)
    expect(usesPatch("glm-5.3-flash")).toBe(false)
  })

  test("approve-for-me lets an editing patch through, but a delete or move asks", async () => {
    const asked: string[] = []
    const permissions = new Permissions(async (tool, detail) => { asked.push(askedFor(tool, detail)); return "once" })
    permissions.mode = "approve"
    await permissions.decide("apply_patch", JSON.stringify({ patch: patch("*** Update File: a.ts", "-x", "+y") }))
    expect(asked).toEqual([])
    await permissions.decide("apply_patch", JSON.stringify({ patch: patch("*** Delete File: a.ts") }))
    expect(asked).toEqual(["deletes or moves files: a.ts"])
  })

  test("offered to a Codex model and not to others", async () => {
    const realFetch = globalThis.fetch
    const offered: string[][] = []
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      offered.push((JSON.parse(String(init?.body)).tools ?? []).map((tool: { function: { name: string } }) => tool.function.name))
      return new Response("data: " + JSON.stringify({ choices: [{ delta: { content: "ok" } }] }) + "\n\ndata: [DONE]\n\n")
    }) as unknown as typeof fetch
    try {
      const provider = (id: string): Provider => ({ id: "test", label: "T", baseUrl: "https://example.invalid/v1/chat/completions", models: [{ id, label: id, contextWindow: 128000 }] })
      for (const id of ["gpt-5.2-codex", "glm-5.3"]) {
        const messages: Message[] = [{ role: "user", content: "hi" }]
        for await (const _ of runAgent({ provider: provider(id), modelId: id, apiKey: "k", root: process.cwd(), messages, checkpoint: 0, spendLimit: 0 })) void _
      }
    } finally { globalThis.fetch = realFetch }
    expect(offered[0]).toContain("apply_patch")
    expect(offered[1]).not.toContain("apply_patch")
  })
})

describe("approving a patch for the session", () => {
  test("covers editing patches only; a deleting one is its own approval", async () => {
    const asked: string[] = []
    const permissions = new Permissions(async (_tool, _detail, cover) => { asked.push(cover); return "always" })
    const edit = JSON.stringify({ patch: patch("*** Update File: a.ts", "-x", "+y") })
    const remove = JSON.stringify({ patch: patch("*** Delete File: a.ts") })
    await permissions.decide("apply_patch", edit)
    await permissions.decide("apply_patch", edit)
    await permissions.decide("apply_patch", remove)
    expect(asked).toEqual(["patches that only add and edit files", "patches that delete or move files"])
  })
})
