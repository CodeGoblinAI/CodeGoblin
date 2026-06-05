import { describe, expect, test } from "bun:test"
import { pickCodeGoblinDirectory, powershellSingleQuote } from "@/server/routes/instance/httpapi/pick-directory"

type RunResult = { code: number; stdout: Buffer; stderr: Buffer }

function fakeRun(result: { code?: number; stdout?: string }, capture?: { cmd?: string[] }) {
  return (async (cmd: string[]) => {
    if (capture) capture.cmd = cmd
    return {
      code: result.code ?? 0,
      stdout: Buffer.from(result.stdout ?? "", "utf8"),
      stderr: Buffer.alloc(0),
    } satisfies RunResult
  }) as any
}

describe("powershellSingleQuote", () => {
  test("wraps in single quotes and doubles internal quotes", () => {
    expect(powershellSingleQuote("C:\\Users\\foo")).toBe("'C:\\Users\\foo'")
    expect(powershellSingleQuote("it's a path")).toBe("'it''s a path'")
  })
})

describe("pickCodeGoblinDirectory", () => {
  test("returns the selected absolute path", async () => {
    const result = await pickCodeGoblinDirectory({
      startDir: "C:/Users/foo",
      run: fakeRun({ code: 0, stdout: "C:\\Users\\foo\\Project" }),
      whichFn: (() => "/usr/bin/zenity") as any,
    })
    expect(result).toEqual({ ok: true, paths: ["C:\\Users\\foo\\Project"] })
  })

  test("treats an empty/cancelled selection as no paths", async () => {
    const result = await pickCodeGoblinDirectory({
      run: fakeRun({ code: 1, stdout: "" }),
      whichFn: (() => "/usr/bin/zenity") as any,
    })
    expect(result).toEqual({ ok: true, paths: [] })
  })

  test("trims trailing whitespace/newlines from the selection", async () => {
    const result = await pickCodeGoblinDirectory({
      run: fakeRun({ code: 0, stdout: "/home/foo/project\n" }),
      whichFn: (() => "/usr/bin/zenity") as any,
    })
    expect(result).toEqual({ ok: true, paths: ["/home/foo/project"] })
  })

  test.skipIf(process.platform !== "win32")("builds an STA PowerShell FolderBrowserDialog command on Windows", async () => {
    const capture: { cmd?: string[] } = {}
    await pickCodeGoblinDirectory({
      title: 'My "Project" folder',
      startDir: "C:/Users/foo",
      run: fakeRun({ code: 0, stdout: "C:\\Users\\foo" }, capture),
    })
    const cmd = capture.cmd ?? []
    expect(cmd[0]).toBe("powershell")
    expect(cmd).toContain("-STA")
    const script = cmd[cmd.length - 1]
    expect(script).toContain("FolderBrowserDialog")
    expect(script).toContain("'C:/Users/foo'") // start dir, single-quoted
    expect(script).not.toContain('"') // title double-quotes stripped before interpolation
  })

  test.skipIf(process.platform === "win32" || process.platform === "darwin")(
    "reports no picker when neither zenity nor kdialog is present",
    async () => {
      const result = await pickCodeGoblinDirectory({
        run: fakeRun({ code: 0, stdout: "" }),
        whichFn: (() => null) as any,
      })
      expect(result.ok).toBe(false)
    },
  )
})
