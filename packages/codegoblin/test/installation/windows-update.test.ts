import { readFileSync } from "fs"
import { join } from "path"
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

describe("Windows update helper does not relaunch", () => {
  // The helper used to spawn the updated executable with `detached: true` and
  // `stdio: "ignore"`. A TUI with no stdio can neither draw nor read input, and
  // detaching from an already-detached helper orphaned it immediately — so every
  // update left an invisible zombie behind and no visible CodeGoblin, which read
  // as "the update uninstalled it". Keep that shape from coming back.
  const source = readFileSync(
    join(import.meta.dir, "../../src/installation/windows-update.ts"),
    "utf8",
  )

  /** Comments stripped: the fix is documented in prose that quotes the old code. */
  const stripComments = (text: string) =>
    text
      .split("\n")
      .filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*"))
      .join("\n")

  /** Just the helper body, so the legitimate `run()` and `prepare` spawns are excluded. */
  const helperBody = stripComments(
    source.slice(
      source.indexOf("export async function runWindowsUpdateHelper"),
      source.indexOf("export async function cleanupWindowsUpdate"),
    ),
  )

  test("the helper body spawns nothing at all", () => {
    expect(helperBody.length).toBeGreaterThan(0)
    expect(helperBody).not.toContain("spawn(")
    expect(helperBody).not.toContain("child.unref()")
    expect(helperBody).not.toContain("detached: true")
  })

  test("still hands the helper itself off detached, which is correct", () => {
    // The helper must outlive the process being replaced; only the
    // post-update relaunch of the TUI was wrong.
    const prepare = source.slice(0, source.indexOf("export async function runWindowsUpdateHelper"))
    expect(prepare).toContain("detached: true")
    expect(prepare).toContain("child.unref()")
  })

  test("cleans up its own temp directory now that nothing inherits it", () => {
    expect(source).toContain("removeUpdateDirectory")
  })
})
