import { describe, expect, test } from "bun:test"
import {
  needsWindowsUpdateHandoff,
  windowsUpdateRestartArguments,
  windowsUpdateStatePath,
} from "../../src/installation/windows-update"

describe("Windows update handoff", () => {
  test("hands compiled Windows package-manager updates to a helper", () => {
    expect(
      needsWindowsUpdateHandoff({
        method: "npm",
        platform: "win32",
        execPath: "C:\\Users\\dev\\AppData\\Roaming\\npm\\node_modules\\codegoblin-windows-x64\\bin\\codegoblin.exe",
      }),
    ).toBe(true)
  })

  test("hands every supported Windows package manager to the helper", () => {
    for (const method of ["curl", "npm", "yarn", "pnpm", "bun", "brew", "scoop", "choco"] as const) {
      expect(needsWindowsUpdateHandoff({ method, platform: "win32", execPath: "C:\\tools\\codegoblin.exe" })).toBe(true)
    }
  })

  test("keeps source, helper, non-Windows, and unknown updates in-process", () => {
    expect(needsWindowsUpdateHandoff({ method: "npm", platform: "win32", execPath: "C:\\tools\\bun.exe" })).toBe(false)
    expect(
      needsWindowsUpdateHandoff({
        method: "npm",
        platform: "win32",
        execPath: "C:\\tools\\codegoblin.exe",
        helper: "1",
      }),
    ).toBe(false)
    expect(needsWindowsUpdateHandoff({ method: "npm", platform: "linux", execPath: "/usr/bin/codegoblin" })).toBe(false)
    expect(
      needsWindowsUpdateHandoff({
        method: "unknown",
        platform: "win32",
        execPath: "C:\\tools\\codegoblin.exe",
      }),
    ).toBe(false)
  })

  test("finds only complete helper invocations", () => {
    expect(windowsUpdateStatePath(["codegoblin.exe", "--codegoblin-update-helper", "C:\\Temp\\state.json"])).toBe(
      "C:\\Temp\\state.json",
    )
    expect(windowsUpdateStatePath(["codegoblin.exe", "update"])).toBeUndefined()
    expect(windowsUpdateStatePath(["codegoblin.exe", "--codegoblin-update-helper"])).toBeUndefined()
  })

  test("preserves launch arguments without repeating the update command", () => {
    expect(windowsUpdateRestartArguments(["--print-logs", "C:\\repo"])).toEqual(["--print-logs", "C:\\repo"])
    expect(windowsUpdateRestartArguments(["update", "0.2.9"])).toEqual([])
    expect(windowsUpdateRestartArguments(["upgrade"])).toEqual([])
  })
})
