import { describe, expect, test } from "bun:test"
import { runTool } from "../src/core/tools"

describe("tool sandbox", () => {
  const root = process.cwd()

  // A model can be talked into asking for anything, so confinement is the
  // tool's job rather than the prompt's.
  test("refuses to escape the working directory", async () => {
    for (const target of [
      "../../../Windows/System32/drivers/etc/hosts",
      "C:/Windows/System32/drivers/etc/hosts",
      "../secrets.txt",
      "..",
    ]) {
      const result = await runTool("read_file", { path: target }, root)
      expect(result.startsWith("error:")).toBe(true)
    }
  })

  test("reads a file inside the working directory", async () => {
    const result = await runTool("read_file", { path: "package.json" }, root)
    expect(result).toContain('"name"')
  })

  test("reports unknown tools instead of throwing", async () => {
    expect(await runTool("rm_rf", {}, root)).toContain("unknown tool")
  })

  test("lists files without exposing node_modules", async () => {
    const result = await runTool("list_files", {}, root)
    expect(result).toContain("package.json")
    expect(result).not.toContain("node_modules")
  })
})

describe("edit_file", () => {
  const root = process.cwd()
  const scratch = "test-scratch.txt"

  test("replaces a unique string and reports a diff", async () => {
    await runTool("write_file", { path: scratch, content: "alpha\nbeta\ngamma\n" }, root)
    const result = await runTool("edit_file", { path: scratch, old_string: "beta", new_string: "BETA" }, root)
    expect(result).toContain("+1 -1")
    expect(result).toContain("- beta")
    expect(result).toContain("+ BETA")
    const after = await runTool("read_file", { path: scratch }, root)
    expect(after).toContain("BETA")
  })

  test("refuses when the string is missing", async () => {
    const result = await runTool("edit_file", { path: scratch, old_string: "nowhere", new_string: "x" }, root)
    expect(result).toContain("not found")
  })

  test("refuses when the string is ambiguous", async () => {
    await runTool("write_file", { path: scratch, content: "dup\ndup\n" }, root)
    const result = await runTool("edit_file", { path: scratch, old_string: "dup", new_string: "x" }, root)
    expect(result).toContain("appears 2 times")
  })

  test("cannot edit outside the working directory", async () => {
    const result = await runTool("edit_file", { path: "../escape.txt", old_string: "a", new_string: "b" }, root)
    expect(result.startsWith("error:")).toBe(true)
  })
})

describe("protected paths", () => {
  const root = process.cwd()

  // A model asked to "fix the repo" can reach for .git; these are never
  // what was actually wanted, and the damage is hard to undo.
  test("refuses to write inside .git", async () => {
    const result = await runTool("write_file", { path: ".git/config", content: "x" }, root)
    expect(result).toContain("protected")
  })

  test("refuses to write inside node_modules", async () => {
    const result = await runTool("write_file", { path: "node_modules/evil.js", content: "x" }, root)
    expect(result).toContain("protected")
  })

  test("refuses to rewrite lockfiles", async () => {
    const result = await runTool("write_file", { path: "package-lock.json", content: "{}" }, root)
    expect(result).toContain("lockfile")
  })

  test("still allows ordinary writes", async () => {
    const result = await runTool("write_file", { path: "test-ok.txt", content: "fine" }, root)
    expect(result).toContain("wrote")
  })
})
