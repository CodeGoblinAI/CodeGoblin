import { describe, expect, test } from "bun:test"
import { inlineCode } from "@/tool/shell"

/**
 * `inlineCode` decides whether an approved command may be widened into an arity
 * wildcard. For interpreters that take a program as an argument it must not be,
 * because `python3 -c '<anything>'` shares every prefix token.
 */
describe("inlineCode", () => {
  const runners: string[][] = [
    ["python3", "-c", "print(1)"],
    ["python", "-c", "print(1)"],
    ["py", "-c", "print(1)"],
    ["node", "-e", "console.log(1)"],
    ["node", "--eval", "console.log(1)"],
    ["bun", "-e", "console.log(1)"],
    ["deno", "eval", "-p", "1"],
    ["perl", "-e", "print 1"],
    ["ruby", "-e", "puts 1"],
    ["php", "-r", "echo 1;"],
    ["sh", "-c", "id"],
    ["bash", "-c", "id"],
    ["zsh", "-c", "id"],
    ["osascript", "-e", "beep"],
  ]

  for (const tokens of runners) {
    test(`detects ${tokens.slice(0, 2).join(" ")}`, () => {
      expect(inlineCode(tokens)).toBe(true)
    })
  }

  test("is case-insensitive on the flag for PowerShell", () => {
    expect(inlineCode(["pwsh", "-Command", "Get-Process"])).toBe(true)
    expect(inlineCode(["powershell.exe", "-EncodedCommand", "ZQ=="])).toBe(true)
  })

  test("matches an absolute path to the interpreter", () => {
    expect(inlineCode(["/usr/bin/python3", "-c", "print(1)"])).toBe(true)
    expect(inlineCode(["C:\\Python311\\python.exe", "-c", "print(1)"])).toBe(true)
  })

  test("ignores interpreters running a script file", () => {
    // Running a named file is safe to widen: the file is the identity, and the
    // read/edit permissions already cover changing it.
    expect(inlineCode(["python3", "script.py"])).toBe(false)
    expect(inlineCode(["node", "server.js"])).toBe(false)
    expect(inlineCode(["ruby", "app.rb"])).toBe(false)
  })

  test("ignores ordinary commands that happen to take -c or -e", () => {
    expect(inlineCode(["grep", "-e", "pattern", "file"])).toBe(false)
    expect(inlineCode(["sort", "-c", "file"])).toBe(false)
    expect(inlineCode(["git", "commit", "-e"])).toBe(false)
  })

  test("ignores a bare interpreter", () => {
    expect(inlineCode(["python3"])).toBe(false)
    expect(inlineCode(["sh"])).toBe(false)
  })

  test("handles empty input", () => {
    expect(inlineCode([])).toBe(false)
  })
})
