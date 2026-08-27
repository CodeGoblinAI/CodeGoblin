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
