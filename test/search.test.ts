import { describe, expect, test } from "bun:test"
import { globToRegExp, globFiles, grepFiles } from "../src/core/search"
import { runTool, SKIP_DIRS } from "../src/core/tools"
import { stopAllJobs } from "../src/core/jobs"

const root = process.cwd()

test("generated and recovered directories stay out of project search", () => {
  expect([...SKIP_DIRS]).toEqual(expect.arrayContaining(["output", ".playwright-cli", "_RECOVERED_LOCAL_2026-08-29"]))
})

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

  test("{a,b} matches either, and nothing else", () => {
    const matcher = globToRegExp("src/{tui,web,cli}/*.ts")
    expect(matcher.test("src/tui/app.ts")).toBe(true)
    expect(matcher.test("src/web/serve.ts")).toBe(true)
    expect(matcher.test("src/cli/prompt.ts")).toBe(true)
    expect(matcher.test("src/core/agent.ts")).toBe(false)
  })

  test("alternatives can hold their own wildcards", () => {
    const matcher = globToRegExp("{src/**/*.ts,*.json}")
    expect(matcher.test("src/core/deep/agent.ts")).toBe(true)
    expect(matcher.test("package.json")).toBe(true)
    expect(matcher.test("README.md")).toBe(false)
  })

  test("braces nest, and the inner commas stay inside", () => {
    const matcher = globToRegExp("src/{core,{tui,web}}/*.ts")
    expect(matcher.test("src/core/agent.ts")).toBe(true)
    expect(matcher.test("src/web/serve.ts")).toBe(true)
    expect(matcher.test("src/domain/brand.ts")).toBe(false)
  })

  test("a comma outside braces is just a comma", () => {
    expect(globToRegExp("a,b.ts").test("a,b.ts")).toBe(true)
    expect(globToRegExp("a,b.ts").test("a.ts")).toBe(false)
  })

  test("a brace nobody closed is a literal brace, not a broken pattern", () => {
    expect(globToRegExp("weird{name.ts").test("weird{name.ts")).toBe(true)
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

  test("an alternation reaches every directory it names", async () => {
    const files = await globFiles(root, "src/{tui,web,cli}/*.ts")
    expect(files).toContain("src/tui/app.ts")
    expect(files).toContain("src/web/serve.ts")
    expect(files).toContain("src/cli/prompt.ts")
    expect(files.some((file) => file.startsWith("src/core/"))).toBe(false)
  })

  test("a pattern that finds nothing says which pattern that was", async () => {
    const result = await runTool("glob", { pattern: "src/nowhere/*.zzz" }, root)
    expect(result).toContain("src/nowhere/*.zzz")
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

  test("stops waiting for a command that overruns its wait, without ending it", async () => {
    const started = Date.now()
    // Something that only waits, for twenty seconds, in each system's own words.
    const waits = process.platform === "win32" ? "ping -n 20 127.0.0.1" : "sleep 20"
    const result = await runTool("shell", { command: waits, timeout_ms: 1200 }, root)
    expect(result).toContain("still running after 1s")
    expect(Date.now() - started).toBeLessThan(8000)
    expect(stopAllJobs()).toBe(1)
  })

  test("refuses an empty command", async () => {
    expect(await runTool("shell", { command: "  " }, root)).toContain("error")
  })
})
