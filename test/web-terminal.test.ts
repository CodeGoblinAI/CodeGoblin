import { describe, expect, test } from "bun:test"
import os from "node:os"
import { endTerminal, startTerminal, terminalMessage, terminalShell, type TerminalSocket } from "../src/web/terminal"

describe("the browser terminal", () => {
  test("starts PowerShell on Windows and $SHELL elsewhere", () => {
    expect(terminalShell("linux", { SHELL: "/bin/zsh" })).toEqual(["/bin/zsh"])
    expect(terminalShell("linux", {})).toEqual(["/bin/sh"])
    expect(terminalShell("win32", { PATH: "" })).toEqual(["powershell.exe", "-NoLogo"])
  })

  test("runs what is typed in the project folder, without secret variables, and ends with the page", async () => {
    process.env.CG_TERMINAL_TEST_API_KEY = "sk-should-never-reach-the-shell"
    let output = ""
    let closed = false
    const socket: TerminalSocket = {
      data: { cwd: os.tmpdir() },
      send(raw) { const message = JSON.parse(raw); if (message.type === "output") output += message.data },
      close() { closed = true },
    }
    startTerminal(socket, 100, 30)
    const until = async (pattern: RegExp, ms = 20000) => {
      const end = Date.now() + ms
      while (!pattern.test(output) && Date.now() < end) await Bun.sleep(100)
      return pattern.test(output)
    }
    const typed = process.platform === "win32"
      ? "echo ('cg-' + 'term-ok'); echo ('key=[' + $env:CG_TERMINAL_TEST_API_KEY + ']')\r"
      : "echo cg-term-ok; echo \"key=[$CG_TERMINAL_TEST_API_KEY]\"\n"
    // Wait for the shell to be ready, then type.
    await Bun.sleep(1500)
    terminalMessage(socket, JSON.stringify({ type: "input", data: typed }))
    expect(await until(/cg-term-ok/)).toBe(true)
    expect(await until(/key=\[\]/)).toBe(true)
    expect(output).not.toContain("sk-should-never-reach-the-shell")
    // Junk and oversized input are ignored rather than typed.
    terminalMessage(socket, "not json")
    terminalMessage(socket, JSON.stringify({ type: "input", data: "x".repeat(70_000) }))
    terminalMessage(socket, JSON.stringify({ type: "resize", cols: 120, rows: 40 }))
    const shell = socket.data.shell!
    endTerminal(socket)
    await shell.exited
    expect(socket.data.shell).toBeUndefined()
    delete process.env.CG_TERMINAL_TEST_API_KEY
    void closed
  }, 40000)
})
