import { describe, expect, test } from "bun:test"
import { globToRegExp, globFiles, grepFiles } from "../src/core/search"
import { runTool } from "../src/core/tools"

const root = process.cwd()

describe("glob patterns", () => {
  test("* stays inside one path segment", () => {
    expect(globToRegExp("src/*.ts").test("src/a.ts")).toBe(true)
    expect(globToRegExp("src/*.ts").test("src/deep/a.ts")).toBe(false)
  })

  test("** crosses segments", () => {
    expect(globToRegExp("src/**/*.ts").test("src/deep/nested/a.ts")).toBe(true)
  })

  test("a dot is literal, not any-character", () => {
    expect(globToRegExp("*.ts").test("ats")).toBe(false)
  })
})

describe("search", () => {
  test("glob finds real files", async () => {
    const files = await globFiles(root, "src/core/*.ts")
    expect(files).toContain("src/core/tools.ts")
  })

  test("glob never returns node_modules", async () => {
    const files = await globFiles(root, "**/*.json")
    expect(files.some((f) => f.includes("node_modules"))).toBe(false)
  })

  test("grep finds a known string with file and line", async () => {
    const { matches } = await grepFiles(root, "PROTECTED_SEGMENTS", "src/**/*.ts")
    expect(matches.length).toBeGreaterThan(0)
    expect(matches[0]).toContain("src/core/tools.ts:")
  })

  test("grep survives an invalid regex by searching literally", async () => {
    const { matches } = await grepFiles(root, "read_file(", "src/core/*.ts")
    expect(Array.isArray(matches)).toBe(true)
  })
})

describe("shell tool", () => {
  test("runs a command and returns its output", async () => {
    const result = await runTool("shell", { command: "echo sandbox-check" }, root)
    expect(result).toContain("sandbox-check")
  })

  test("reports a non-zero exit rather than pretending it worked", async () => {
    const result = await runTool("shell", { command: "exit 3" }, root)
    expect(result).toContain("exit code 3")
  })

  test("kills a command that overruns its timeout", async () => {
    const started = Date.now()
    const result = await runTool("shell", { command: "ping -n 20 127.0.0.1", timeout_ms: 1200 }, root)
    expect(result).toContain("killed after")
    expect(Date.now() - started).toBeLessThan(8000)
  })

  test("refuses an empty command", async () => {
    expect(await runTool("shell", { command: "  " }, root)).toContain("error")
  })
})
