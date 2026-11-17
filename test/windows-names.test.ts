import { expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { isSecretPath } from "../src/core/secret-files"
import { Permissions } from "../src/core/permission"
import { runTool } from "../src/core/tools"

/**
 * Windows reads one file by several names. Secret files are asked about by name in every mode, so each
 * other spelling of a name was a way past that question; and a few names are devices, which the file tools
 * turned into files nothing can delete.
 */
const windows = process.platform === "win32"
const root = fs.mkdtempSync(path.join(os.tmpdir(), "cg-winnames-"))
fs.writeFileSync(path.join(root, ".env"), "SECRET_TOKEN=abc123")
fs.writeFileSync(path.join(root, "auth.json"), '{"key":"abc123"}')

test("a stream name, or a trailing dot or space, is still the secret file's name", () => {
  for (const name of [".env::$DATA", ".env:$DATA", ".ENV::$DATA", "id_rsa.", ".env ", "auth.json::$DATA", "C:/u/.ssh::$INDEX_ALLOCATION/config"]) {
    expect([name, isSecretPath(name)]).toEqual([name, true])
  }
  // Templates are still templates, and a drive letter is not a stream.
  expect(isSecretPath(".env.example::$DATA")).toBe(false)
  expect(isSecretPath("C:/project/readme.md")).toBe(false)
})

test("full access still asks before a secret file is read by its stream name", () => {
  const permissions = new Permissions(async () => "reject")
  permissions.mode = "full"
  expect(permissions.automaticVerdict("read_file", JSON.stringify({ path: ".env::$DATA" }))).toBeUndefined()
  expect(permissions.automaticVerdict("shell", JSON.stringify({ command: "more < .env::$DATA" }))).toBeUndefined()
  expect(permissions.automaticVerdict("read_file", JSON.stringify({ path: "readme.md" }))).toEqual({ allowed: true })
})

test.if(windows)("a device name is never written as a file", async () => {
  for (const name of ["nul", "CON", "com1.txt", "sub/aux.js", "notes.", "trailing ", "auth.json:hidden", "readme.md::$DATA"]) {
    const result = await runTool("write_file", { path: name, content: "x" }, root)
    expect([name, result.startsWith("error: refusing to write")]).toEqual([name, true])
  }
  expect(fs.readdirSync(root).sort()).toEqual([".env", "auth.json"])
  // Ordinary names that only start like one are fine.
  expect(await runTool("write_file", { path: "console.log.txt", content: "x" }, root)).toStartWith("wrote")
})

// Short names exist only where the volume makes them; where it does, ENV~1 is .env.
const shortNames = windows && (() => { try { return path.basename(fs.realpathSync.native(path.join(root, "ENV~1"))) === ".env" } catch { return false } })()

test.if(shortNames)("a short name for a secret file is refused, with the real name to ask for", async () => {
  const read = await runTool("read_file", { path: "ENV~1" }, root)
  expect(read).toContain('"ENV~1" is another name for .env')
  expect(read).not.toContain("abc123")
  const shell = await runTool("shell", { command: "type AUTH~1.JSO" }, root)
  expect(shell).toContain("another name for auth.json")
  expect(shell).toContain("Nothing was run")
  expect(shell).not.toContain("abc123")
  // A tilde that is not a file, or a short name of an ordinary file, is left alone.
  expect(await runTool("shell", { command: "echo HEAD~1" }, root)).toContain("HEAD~1")
})
