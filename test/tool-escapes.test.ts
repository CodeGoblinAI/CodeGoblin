import { beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { runTool, shellEnvironment } from "../src/core/tools"
import { Global } from "../src/platform/paths"
import { requireSandbox } from "./sandbox"

/** Ways out of the project found by driving the real model with odd prompts. */
const home = Global.Path.home
let project = ""
let outside = ""

beforeAll(() => {
  requireSandbox(path.join(home, "escapes", "x"), "the tool escape tests")
  project = fs.mkdtempSync(path.join(home, "escapes-project-"))
  outside = fs.mkdtempSync(path.join(home, "escapes-outside-"))
  fs.writeFileSync(path.join(outside, "secret.txt"), "outside canary")
  fs.writeFileSync(path.join(project, "inside.txt"), "inside")
  // A junction needs no elevation on Windows; elsewhere it is a plain directory link.
  fs.symlinkSync(outside, path.join(project, "linked"), "junction")
})

describe("a link inside the project that points outside it", () => {
  test("cannot be read through", async () => {
    const result = await runTool("read_file", { path: "linked/secret.txt" }, project)
    expect(result).toContain("through a link")
    expect(result).not.toContain("outside canary")
  })

  test("cannot be listed or written through", async () => {
    expect(await runTool("list_files", { path: "linked" }, project)).toContain("through a link")
    expect(await runTool("write_file", { path: "linked/planted.txt", content: "x" }, project)).toContain("through a link")
    expect(fs.existsSync(path.join(outside, "planted.txt"))).toBe(false)
  })

  test("ordinary files, and new ones, are still fine", async () => {
    expect(await runTool("read_file", { path: "inside.txt" }, project)).toBe("inside")
    expect(await runTool("write_file", { path: "new/deep/file.txt", content: "x" }, project)).toContain("wrote")
  })
})

describe("a command the model runs", () => {
  test("does not get variables that hold keys, secrets, tokens or passwords", () => {
    const env = shellEnvironment({ PATH: "p", DEEPSEEK_API_KEY: "k", GITHUB_TOKEN: "t", AWS_SECRET_ACCESS_KEY: "s", DB_PASSWORD: "w", HOME: "h" })
    // What is left: what was harmless, and the one git setting the app adds (print file names as they are).
    expect(Object.keys(env).sort()).toEqual(["GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0", "HOME", "PATH"])
    expect(Object.values(env).some((value) => ["k", "t", "s", "w"].includes(String(value)))).toBe(false)
  })

  test("really cannot print one", async () => {
    process.env.CG_ESCAPE_TEST_API_KEY = "sk-escape-canary"
    try {
      const command = process.platform === "win32" ? "echo [%CG_ESCAPE_TEST_API_KEY%]" : "echo [$CG_ESCAPE_TEST_API_KEY]"
      expect(await runTool("shell", { command }, project)).not.toContain("sk-escape-canary")
    } finally {
      delete process.env.CG_ESCAPE_TEST_API_KEY
    }
  })
})
