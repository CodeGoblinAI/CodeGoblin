import { expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Global } from "../src/platform/paths"
import { availableUpdate, checksAllowed, newer, offered, updateLine } from "../src/core/update"
import { parseConfig } from "../src/core/config"
import { route } from "../src/cli/route"
import * as launcher from "../npm/launcher.mjs"
import { requireSandbox } from "./sandbox"

const ORDER: [string, string, boolean][] = [
  ["0.4.1", "0.4.0", true], ["0.4.0", "0.4.1", false], ["0.4.0", "0.4.0", false],
  ["0.10.0", "0.9.9", true], ["1.0.0", "0.99.99", true],
  // A preview comes before the release it leads to, and previews are ordered by their number, not as text.
  ["0.4.0", "0.4.0-next.3", true], ["0.4.0-next.3", "0.4.0", false],
  ["0.4.0-next.10", "0.4.0-next.9", true], ["0.4.0-next.2", "0.4.0-next.10", false],
  ["0.4.1-next.1", "0.4.0", true], ["0.4.0-next.1", "0.3.12", true],
  ["v0.4.1", "0.4.0", true],
  // Anything that is not a version is never an update.
  ["latest", "0.4.0", false], ["", "0.4.0", false], ["0.4", "0.3.0", false], ["0.4.1; rm -rf", "0.4.0", false],
]

test("version order, and the launcher agrees with the app on every case", () => {
  for (const [candidate, current, expected] of ORDER) {
    expect([candidate, current, newer(candidate, current)]).toEqual([candidate, current, expected])
    expect([candidate, current, launcher.newer(candidate, current)]).toEqual([candidate, current, expected])
  }
})

test("a released version is offered only releases; a preview is also offered later previews", () => {
  const tags = { latest: "0.4.0", next: "0.5.0-next.2" }
  expect(offered("0.3.12", tags)).toBe("0.4.0")
  expect(offered("0.4.0", tags)).toBeUndefined()
  expect(offered("0.5.0-next.1", tags)).toBe("0.5.0-next.2")
  expect(offered("0.4.0-next.1", { latest: "0.4.0", next: "0.4.0-next.4" })).toBe("0.4.0")
  expect(offered("0.4.0", { latest: 7, next: null })).toBeUndefined()
})

test("no check from a source checkout, or when switched off the way 0.3 was", () => {
  expect(checksAllowed({}, "0.4.0-dev")).toBe(false)
  expect(checksAllowed({}, "0.4.0")).toBe(true)
  expect(checksAllowed({ CODEGOBLIN_DISABLE_AUTOUPDATE: "1" }, "0.4.0")).toBe(false)
  expect(checksAllowed({}, "0.4.0", parseConfig('{ "autoupdate": false }'))).toBe(false)
  expect(checksAllowed({}, "0.4.0", parseConfig("{}"))).toBe(true)
})

test("asks the registry once a day, answers from memory in between, and says nothing when it cannot ask", async () => {
  requireSandbox(Global.Path.state, "update tests")
  const file = path.join(Global.Path.state, "update.json")
  fs.rmSync(file, { force: true })
  let asked = 0
  const registry = (tags: object) => (async (url: string | URL | Request) => {
    asked++
    expect(String(url)).toBe("https://registry.npmjs.org/@codegoblin-io%2fcodegoblin")
    return new Response(JSON.stringify({ "dist-tags": tags }))
  }) as unknown as typeof fetch
  const down = (async () => { asked++; throw new Error("offline") }) as unknown as typeof fetch
  const t0 = 1_800_000_000_000
  // Offline on the very first start: nothing to say, and nothing remembered.
  expect(await availableUpdate({ current: "0.4.0", now: t0, fetcher: down, allowed: true })).toBeUndefined()
  expect(await availableUpdate({ current: "0.4.0", now: t0, fetcher: registry({ latest: "0.4.1" }), allowed: true })).toBe("0.4.1")
  expect(asked).toBe(2)
  // An hour later: no request, same answer. After the update it has nothing to say, still without asking.
  expect(await availableUpdate({ current: "0.4.0", now: t0 + 3_600_000, fetcher: down, allowed: true })).toBe("0.4.1")
  expect(await availableUpdate({ current: "0.4.1", now: t0 + 3_600_000, fetcher: down, allowed: true })).toBeUndefined()
  expect(asked).toBe(2)
  // The next day it asks again; if that fails it keeps what it knew.
  expect(await availableUpdate({ current: "0.4.0", now: t0 + 25 * 3_600_000, fetcher: down, allowed: true })).toBe("0.4.1")
  expect(await availableUpdate({ current: "0.4.0", now: t0 + 25 * 3_600_000, fetcher: registry({ latest: "0.4.2" }), allowed: true })).toBe("0.4.2")
  expect(asked).toBe(4)
  // Switched off: no request at all.
  expect(await availableUpdate({ current: "0.4.0", now: t0 + 99 * 3_600_000, fetcher: down, allowed: false })).toBeUndefined()
  expect(asked).toBe(4)
  fs.writeFileSync(file, "not json")
  expect(await availableUpdate({ current: "0.4.0", now: t0, fetcher: down, allowed: true })).toBeUndefined()
  expect(updateLine("0.4.2")).toContain("codegoblin upgrade")
  fs.rmSync(file, { force: true })
})

test("`upgrade` and `update` are both the upgrade command", () => {
  expect(route(["upgrade"])).toEqual({ kind: "upgrade", args: [] })
  expect(route(["update", "next"])).toEqual({ kind: "upgrade", args: ["next"] })
})

test("launcher: which program belongs to this computer", () => {
  expect(launcher.platformPackage("win32", "x64")).toBe("codegoblin-windows-x64")
  expect(launcher.platformPackage("linux", "arm64")).toBe("codegoblin-linux-arm64")
  expect(launcher.platformPackage("darwin", "arm64")).toBe("codegoblin-darwin-arm64")
  // No program is published for these; saying so beats looking for a package that does not exist.
  expect(launcher.platformPackage("darwin", "x64")).toBeUndefined()
  expect(launcher.platformPackage("freebsd", "x64")).toBeUndefined()
  expect(launcher.platformPackage("linux", "ia32")).toBeUndefined()
})

test("launcher: finds the program wherever the package manager put it", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "cg-launcher-"))
  const make = (...parts: string[]) => { const file = path.join(base, ...parts); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, ""); return file }
  // npm -g: nested under the installer package.
  const nested = make("a", "node_modules", "@codegoblin-io", "codegoblin", "node_modules", "codegoblin-linux-x64", "bin", "codegoblin")
  expect(launcher.findProgram(path.join(base, "a", "node_modules", "@codegoblin-io", "codegoblin", "bin"), "codegoblin-linux-x64", "linux")).toBe(nested)
  // A flat install: beside it.
  const flat = make("b", "node_modules", "codegoblin-windows-x64", "bin", "codegoblin.exe")
  fs.mkdirSync(path.join(base, "b", "node_modules", "@codegoblin-io", "codegoblin", "bin"), { recursive: true })
  expect(launcher.findProgram(path.join(base, "b", "node_modules", "@codegoblin-io", "codegoblin", "bin"), "codegoblin-windows-x64", "win32")).toBe(flat)
  expect(launcher.findProgram(path.join(base, "b"), "codegoblin-linux-arm64", "linux")).toBeUndefined()
})

test("launcher: updates with whichever package manager installed it", () => {
  expect(launcher.installedBy(path.join("C:", "Users", "x", "AppData", "Roaming", "npm", "node_modules", "@codegoblin-io", "codegoblin", "bin", "codegoblin.mjs"))).toBe("npm")
  expect(launcher.installedBy(path.join("/home/x", ".bun", "install", "global", "node_modules", "@codegoblin-io", "codegoblin", "bin", "codegoblin.mjs"))).toBe("bun")
  expect(launcher.installedBy(path.join("/home/x", ".local", "share", "pnpm", "global", "5", "node_modules", "@codegoblin-io", "codegoblin", "bin", "codegoblin.mjs"))).toBe("pnpm")
  expect(launcher.installCommand("npm", "0.4.1", "linux")).toEqual(["npm", ["install", "-g", "@codegoblin-io/codegoblin@0.4.1"]])
  expect(launcher.installCommand("npm", "0.4.1", "win32")).toEqual(["npm.cmd", ["install", "-g", "@codegoblin-io/codegoblin@0.4.1"]])
  expect(launcher.installCommand("pnpm", "0.4.1", "linux")).toEqual(["pnpm", ["add", "-g", "@codegoblin-io/codegoblin@0.4.1"]])
  expect(launcher.installCommand("bun", "0.4.1", "win32")).toEqual(["bun", ["add", "-g", "@codegoblin-io/codegoblin@0.4.1"]])
})

test("launcher: what `upgrade` installs", () => {
  const tags = { latest: "0.4.1", next: "0.5.0-next.1" }
  expect(launcher.target(undefined, "0.4.0", tags)).toBe("0.4.1")
  expect(launcher.target(undefined, "0.4.1", tags)).toBeUndefined()
  expect(launcher.target("latest", "0.4.0", tags)).toBe("0.4.1")
  // Asking for the preview by name, and staying on that line afterwards.
  expect(launcher.target("next", "0.4.1", tags)).toBe("0.5.0-next.1")
  expect(launcher.target(undefined, "0.5.0-next.0", tags)).toBe("0.5.0-next.1")
  // A number is installed exactly, older included: that is the way back.
  expect(launcher.target("0.3.12", "0.4.1", tags)).toBe("0.3.12")
  expect(launcher.target("v0.4.1", "0.4.1", tags)).toBeUndefined()
  expect(() => launcher.target("nightly", "0.4.1", tags)).toThrow('no "nightly" version')
  expect(() => launcher.target("0.4.1 && calc", "0.4.0", tags)).toThrow("no ")
})
