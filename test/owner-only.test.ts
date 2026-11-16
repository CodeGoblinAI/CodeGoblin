import { expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { Global } from "../src/platform/paths"
import { connect, apiKey, disconnect, storePath } from "../src/core/auth"
import { requireSandbox } from "./sandbox"

test("on Windows the key store is readable by its owner and nobody else", async () => {
  requireSandbox(Global.Path.data, "owner-only test")
  await connect("owneronly", "a-key-for-the-owner-only-test")
  // Still readable by this user - a key store its owner cannot read would be worse than an open one.
  expect(apiKey("owneronly")).toBe("a-key-for-the-owner-only-test")
  expect(JSON.parse(fs.readFileSync(storePath(), "utf8")).owneronly.key).toBe("a-key-for-the-owner-only-test")
  if (process.platform === "win32") {
    const listing = Bun.spawnSync(["icacls", storePath()]).stdout.toString()
    const entries = listing.split("\n").map((line) => line.replace(storePath(), "").trim()).filter((line) => /:\(/.test(line))
    // Nothing inherited: no groups, sandboxes or app containers that the folder happens to allow. What is left
    // is this user - and, on some machines, the system and administrators, who can read any file regardless.
    const user = (await import("node:os")).userInfo().username.toLowerCase()
    const others = entries.filter((entry) => !entry.toLowerCase().includes("\\" + user + ":") && !entry.toLowerCase().startsWith(user + ":") && !/SYSTEM:|Administrators:/i.test(entry))
    expect(others).toEqual([])
    expect(entries.filter((entry) => entry.includes("(I)"))).toEqual([])
    expect(entries.some((entry) => entry.toLowerCase().includes(user + ":(f)"))).toBe(true)
  } else {
    expect(fs.statSync(storePath()).mode & 0o077).toBe(0)
  }
  // Written again (every connect replaces the file): still owner-only, still readable.
  await connect("owneronly2", "second")
  expect(apiKey("owneronly")).toBe("a-key-for-the-owner-only-test")
  if (process.platform === "win32") expect(Bun.spawnSync(["icacls", storePath()]).stdout.toString().split("\n").filter((line) => /\(I\)/.test(line)).length).toBe(0)
  await disconnect("owneronly"); await disconnect("owneronly2")
  expect(fs.existsSync(path.dirname(storePath()))).toBe(true)
})
