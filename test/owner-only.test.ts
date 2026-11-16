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
    // One entry, not inherited: no groups, no sandboxes, no app containers that the folder happens to allow.
    // Said in full when it fails: which entries, who this is, and what a direct attempt answers.
    if (entries.length !== 1) {
      const os = await import("node:os")
      const attempt = Bun.spawnSync(["icacls", storePath(), "/grant:r", os.userInfo().username + ":(F)"])
      console.log("owner-only failed:", JSON.stringify({ entries, user: os.userInfo().username, domain: process.env.USERDOMAIN, attemptExit: attempt.exitCode, attemptSays: (attempt.stdout.toString() + attempt.stderr.toString()).trim().slice(0, 300), whoami: Bun.spawnSync(["whoami"]).stdout.toString().trim() }))
    }
    expect(entries).toHaveLength(1)
    expect(entries[0]).toContain(":(F)")
    expect(entries[0]).not.toContain("(I)")
  } else {
    expect(fs.statSync(storePath()).mode & 0o077).toBe(0)
  }
  // Written again (every connect replaces the file): still owner-only, still readable.
  await connect("owneronly2", "second")
  expect(apiKey("owneronly")).toBe("a-key-for-the-owner-only-test")
  if (process.platform === "win32") expect(Bun.spawnSync(["icacls", storePath()]).stdout.toString().split("\n").filter((line) => /:\(/.test(line)).length).toBe(1)
  await disconnect("owneronly"); await disconnect("owneronly2")
  expect(fs.existsSync(path.dirname(storePath()))).toBe(true)
})
