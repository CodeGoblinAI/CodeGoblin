import { expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { runForeground, startJob, stopAllJobs } from "../src/core/jobs"
import { runTool } from "../src/core/tools"
import { shellCommand } from "../src/platform/process"

/**
 * A command reaches the shell exactly as written.
 *
 * On Windows every double quote used to arrive with a backslash in front of it, which cmd.exe does not read:
 * no path with a space in it could be named, and `mkdir "My Files"` made a folder with a quote in its name.
 * A model asked to move a folder spent five minutes and thirty-three steps working round it. These run real
 * commands in a real folder whose own name has a space in it.
 */
const root = fs.mkdtempSync(path.join(os.tmpdir(), "cg quote test "))
const run = async (command: string) => (await runForeground(command, root, { timeoutMs: 30_000 })).replace(/\r/g, "").trim()
const windows = process.platform === "win32"

test("the shell is started in the form that leaves a command untouched", () => {
  expect(shellCommand('dir "a b"', "win32")).toEqual({ argv: ["cmd.exe", "/d", "/s", "/c", '"chcp 65001>nul 2>&1 & dir "a b""'], options: { windowsVerbatimArguments: true } })
  expect(shellCommand("ls 'a b'", "linux")).toEqual({ argv: ["/bin/sh", "-c", "ls 'a b'"], options: {} })
})

test("quoted words arrive as quoted words", async () => {
  expect(await run(windows ? 'echo "hi there"' : 'echo "hi there"')).toBe(windows ? '"hi there"' : "hi there")
})

test("folders and files with spaces in their names can be made, listed, moved and renamed", async () => {
  if (windows) {
    expect(await run('mkdir "Archive\\2025" && mkdir "Holiday Photos" && echo made')).toBe("made")
    await run('echo x> "Holiday Photos\\my file (2).txt"')
    expect(await run('dir /b "Holiday Photos"')).toBe("my file (2).txt")
    expect(await run('move "Holiday Photos" "Archive\\2025\\"')).toContain("1 dir(s) moved")
    expect(await run('ren "Archive\\2025\\Holiday Photos" "Summer Photos" && dir /b "Archive\\2025"')).toBe("Summer Photos")
    expect(await run('if exist "Archive\\2025\\Summer Photos\\my file (2).txt" (echo yes) else (echo no)')).toBe("yes")
    // A loop variable, a pipe into a quoted pattern, and PowerShell with a quoted command inside it.
    expect(await run('for %f in ("Archive\\2025\\Summer Photos\\*.txt") do @echo [%~nxf]')).toBe("[my file (2).txt]")
    expect(await run('echo alpha& echo beta| findstr "beta"')).toBe("alpha\nbeta")
    expect(await run('powershell -NoProfile -Command "Get-ChildItem -Recurse -File | Select-Object -ExpandProperty Name"')).toBe("my file (2).txt")
  } else {
    expect(await run('mkdir -p "Archive/2025" "Holiday Photos" && echo made')).toBe("made")
    await run('echo x > "Holiday Photos/my file (2).txt"')
    expect(await run('mv "Holiday Photos" "Archive/2025/" && mv "Archive/2025/Holiday Photos" "Archive/2025/Summer Photos" && ls "Archive/2025"')).toBe("Summer Photos")
    expect(await run('ls "Archive/2025/Summer Photos"')).toBe("my file (2).txt")
  }
  // What is on disk is what was asked for: no folder with a quote or a backslash in its name.
  expect(fs.readdirSync(root)).toEqual(["Archive"])
  expect(fs.existsSync(path.join(root, "Archive", "2025", "Summer Photos", "my file (2).txt"))).toBe(true)
}, 60_000)

test("a background job is started the same way", async () => {
  const text = await startJob(windows ? 'echo "from a job" & dir /b "Archive\\2025"' : 'echo "from a job"; ls "Archive/2025"', root, { firstLookMs: 1500 })
  expect(text).toContain(windows ? '"from a job"' : "from a job")
  expect(text).toContain("Summer Photos")
  stopAllJobs(root)
}, 30_000)

test("multi-line commands run every unquoted line, and refuse quoted newlines on Windows instead of silently dropping lines", async () => {
  const out = await run("echo first\necho second")
  expect(out.split("\n").map((s) => s.trim())).toEqual(["first", "second"])

  if (windows) {
    // Previously this ran only `import math` and exited 0, making a failing assertion appear to pass!
    const refused = await runTool("shell", { command: 'python -c "import math\nassert math.sqrt(4) == 999"' }, root)
    expect(refused).toStartWith("error: cmd.exe cuts off commands at a line break inside quotes")

    // Simulate a legacy CP437 hidden console and verify chcp 65001 + PYTHONUTF8=1 keep cmd, PowerShell and Python UTF-8.
    const cpOut = await run('chcp 437 >nul & chcp 65001 >nul 2>&1 & python -c "import pathlib, sys; p = pathlib.Path(\'utf8_check.txt\'); p.write_text(\'café — 日本語\'); print(sys.flags.utf8_mode, p.read_text())"')
    expect(cpOut).toBe("1 café — 日本語")
  }
}, 30_000)
