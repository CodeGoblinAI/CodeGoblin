import { describe, expect, test } from "bun:test"
import { firebaseLoginTerminalCommand } from "../../src/codegoblin/market"

const CMD = ["npx", "-y", "firebase-tools", "login"]

describe("firebaseLoginTerminalCommand", () => {
  test("Windows opens a new cmd window", () => {
    const result = firebaseLoginTerminalCommand("win32", CMD)
    expect(result.argv).toEqual(["cmd", "/c", "start", "Firebase Login", "cmd", "/k", ...CMD])
    expect(result.stdin).toBe("ignore")
  })

  test("macOS runs the command via AppleScript do script, not open -a Terminal", () => {
    const result = firebaseLoginTerminalCommand("darwin", CMD)
    expect(result.argv[0]).toBe("osascript")
    expect(result.argv.some((arg) => arg.includes("do script"))).toBe(true)
    expect(result.argv.some((arg) => arg.includes("firebase-tools login"))).toBe(true)
    // The buggy form passed the npx args straight to `open`; make sure we no longer do that.
    expect(result.argv).not.toContain("open")
    expect(result.stdin).toBe("ignore")
  })

  test("Linux prefers gnome-terminal with -- separator", () => {
    const which = (cmd: string) => (cmd === "gnome-terminal" ? "/usr/bin/gnome-terminal" : null)
    const result = firebaseLoginTerminalCommand("linux", CMD, which)
    expect(result.argv).toEqual(["/usr/bin/gnome-terminal", "--", ...CMD])
    expect(result.stdin).toBe("ignore")
  })

  test("Linux falls back to xterm -e when gnome-terminal/konsole are absent", () => {
    const which = (cmd: string) => (cmd === "xterm" ? "/usr/bin/xterm" : null)
    const result = firebaseLoginTerminalCommand("linux", CMD, which)
    expect(result.argv).toEqual(["/usr/bin/xterm", "-e", "npx -y firebase-tools login"])
  })

  test("Linux konsole uses a single -e command string", () => {
    const which = (cmd: string) => (cmd === "konsole" ? "/usr/bin/konsole" : null)
    const result = firebaseLoginTerminalCommand("linux", CMD, which)
    expect(result.argv).toEqual(["/usr/bin/konsole", "-e", "npx -y firebase-tools login"])
  })

  test("Linux with no terminal emulator runs inline and inherits stdio", () => {
    const result = firebaseLoginTerminalCommand("linux", CMD, () => null)
    expect(result.argv).toEqual([...CMD])
    expect(result.stdin).toBe("inherit")
  })
})
