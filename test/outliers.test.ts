import { beforeAll, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { closeOpenCalls, type Message } from "../src/core/agent"
import { runTool } from "../src/core/tools"
import { Global } from "../src/platform/paths"
import { requireSandbox } from "./sandbox"

/** Failures found by giving the real model odd, bad and hostile prompts. */
const home = Global.Path.home
let project = ""

beforeAll(() => {
  requireSandbox(path.join(home, "outliers", "x"), "the outlier tests")
  project = fs.mkdtempSync(path.join(home, "outliers-"))
})

describe("grep on a big file", () => {
  test("finds lines in a file of several megabytes", async () => {
    const line = "2026-09-13 INFO handled path=/api/sum status=200"
    fs.writeFileSync(path.join(project, "server.log"), Array(80_000).fill(line).join("\n"))
    expect(fs.statSync(path.join(project, "server.log")).size).toBeGreaterThan(3_000_000)
    const result = await runTool("grep", { query: "status=200", include: "server.log" }, project)
    expect(result).toContain("server.log:1:")
    // Past the first hundred, the count is still given, so "how many?" has an answer.
    expect(result).toContain("80000 matching lines in all")
  })
})

describe("the web page's send button", () => {
  test("is never disabled while it is the Stop button", () => {
    const app = fs.readFileSync(path.join(import.meta.dir, "..", "src", "web", "app.js"), "utf8")
    const disabling = app.split("\n").filter((line) => line.includes("sendBtn.disabled ="))
    expect(disabling.length).toBeGreaterThan(0)
    for (const line of disabling) expect(line).not.toMatch(/disabled = busy \|\|/)
  })
})

describe("stopping a turn while a tool runs", () => {
  test("ends the command at once, rather than at its timeout", async () => {
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 700)
    const started = Date.now()
    const command = process.platform === "win32" ? "ping -n 60 127.0.0.94" : "sleep 60"
    const result = await runTool("shell", { command, timeout_ms: 90_000 }, project, undefined, controller.signal)
    expect(result).toContain("stopped by the user")
    expect(Date.now() - started).toBeLessThan(6000)
  }, 20_000)

  test("leaves no call unanswered, so the next message is not rejected", () => {
    const messages: Message[] = [
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          { id: "a", type: "function", function: { name: "read_file", arguments: "{}" } },
          { id: "b", type: "function", function: { name: "shell", arguments: "{}" } },
        ],
      },
      { role: "tool", tool_call_id: "a", content: "done" },
      { role: "user", content: "just say hello" },
    ]
    closeOpenCalls(messages)
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "tool", "tool", "user"])
    expect(messages[3]).toMatchObject({ tool_call_id: "b" })
    expect(messages[3]!.content).toContain("stopped")
    // A conversation with nothing open is left as it is.
    const again = messages.length
    closeOpenCalls(messages)
    expect(messages.length).toBe(again)
  })
})

describe.if(process.platform === "win32")("a shell command killed at its timeout", () => {
  test("takes the program it started with it", async () => {
    // An address nothing else pings, so the process can be found by its command line.
    const result = await runTool("shell", { command: "ping -n 40 127.0.0.93", timeout_ms: 1500 }, project)
    expect(result).toContain("killed after")
    await new Promise((done) => setTimeout(done, 500))
    const found = spawnSync(
      "powershell",
      ["-NoProfile", "-Command", "(Get-CimInstance Win32_Process -Filter \"Name='PING.EXE'\" | Where-Object { $_.CommandLine -like '*127.0.0.93*' }).Count"],
      { encoding: "utf8", windowsHide: true },
    )
    expect(Number(found.stdout.trim() || "0")).toBe(0)
  }, 20_000)
})
