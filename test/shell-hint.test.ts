import { expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { runTool, withShellHint } from "../src/core/tools"

const missing = (name: string) => `'${name}' is not recognized as an internal or external command,\noperable program or batch file.\nexit code 1`

test("PowerShell written into cmd.exe is named as that, with the way to run it", () => {
  for (const command of ["Test-Path .\\Downloads", "Get-ChildItem -Recurse", "$files = Get-ChildItem"]) {
    const first = command.split(" ")[0]!
    const hinted = withShellHint(command, missing(first), "win32")
    expect(hinted).toContain("This shell is cmd.exe, and " + first + " is PowerShell")
    expect(hinted).toContain('powershell -NoProfile -Command "<the command>"')
  }
})

test("a bash habit is given cmd.exe's own word for it", () => {
  expect(withShellHint("ls -la", missing("ls"), "win32")).toContain("which has no ls. Use dir /b.")
  expect(withShellHint("mv a b", missing("mv"), "win32")).toContain("Use move.")
  expect(withShellHint("cat x.txt", missing("cat"), "win32")).toContain("Use type.")
  expect(withShellHint("grep foo *", missing("grep"), "win32")).toContain("the grep tool")
})

test("nothing is added when nothing is known, when it worked, or off Windows", () => {
  expect(withShellHint("frobnicate", missing("frobnicate"), "win32")).toBe(missing("frobnicate"))
  expect(withShellHint("dir", "a.txt\nb.txt", "win32")).toBe("a.txt\nb.txt")
  expect(withShellHint("ls", missing("ls"), "linux")).toBe(missing("ls"))
})

test("the shell tool itself adds the hint", async () => {
  if (process.platform !== "win32") return
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cg-hint-"))
  const result = await runTool("shell", { command: "Test-Path .\\nothing" }, root)
  expect(result).toContain("is not recognized")
  expect(result).toContain("This shell is cmd.exe, and Test-Path is PowerShell")
}, 30_000)
