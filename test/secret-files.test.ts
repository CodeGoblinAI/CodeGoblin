import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { isSecretPath, secretPathsIn } from "../src/core/secret-files"
import { Permissions, coverOf } from "../src/core/permission"
import { runTool } from "../src/core/tools"

describe("which files hold secrets", () => {
  test("key stores, env files, private keys and credential folders", () => {
    for (const file of [
      ".env", "app/.env.local", "auth.json", ".local/share/codegoblin/auth.json", "C:\\Users\\x\\.ssh\\id_ed25519",
      ".ssh/config", ".aws/credentials", "certs/server.pem", "signing.p12", ".npmrc", ".git-credentials", ".docker/config.json",
    ]) expect([file, isSecretPath(file)]).toEqual([file, true])
  })

  test("templates, public keys and ordinary files are not", () => {
    for (const file of [".env.example", ".env.sample", ".ssh/id_ed25519.pub", ".ssh/known_hosts", "src/auth.ts", "package.json", "monkey", "keys.md", "config.json"]) {
      expect([file, isSecretPath(file)]).toEqual([file, false])
    }
  })

  test("a shell command naming one is spotted however it is quoted or chained", () => {
    expect(secretPathsIn('type "C:\\Users\\x\\.local\\share\\codegoblin\\auth.json"')).toEqual(["C:\\Users\\x\\.local\\share\\codegoblin\\auth.json"])
    expect(secretPathsIn("cat .env|more")).toEqual([".env"])
    expect(secretPathsIn("git status && bun test")).toEqual([])
    expect(secretPathsIn("curl https://example.com/.env")).toEqual([])
  })
})

describe("reading a secret file asks, in every mode", () => {
  const asked: string[] = []
  const permissions = () => new Permissions(async (tool, detail, cover) => { asked.push(`${tool}|${cover}`); return "once" })

  test("full access still asks before read_file opens a key store, and before a shell command prints one", async () => {
    asked.length = 0
    const p = permissions()
    p.mode = "full"
    expect((await p.decide("read_file", JSON.stringify({ path: ".local/share/codegoblin/auth.json" }))).allowed).toBe(true)
    expect((await p.decide("shell", JSON.stringify({ command: "type .env" }))).allowed).toBe(true)
    expect(asked).toEqual(["read_file|reading .local/share/codegoblin/auth.json", 'shell|"type" and reading .env'])
    // Ordinary reads and commands in full access are still never asked about.
    await p.decide("read_file", JSON.stringify({ path: "src/index.ts" }))
    await p.decide("shell", JSON.stringify({ command: "bun test" }))
    expect(asked.length).toBe(2)
  })

  test("a refusal is a refusal, and 'for this session' covers just that file", async () => {
    const answers: ("reject" | "always")[] = ["reject", "always"]
    let count = 0
    const p = new Permissions(async () => { count++; return answers.shift() ?? "reject" })
    p.mode = "full"
    expect((await p.decide("read_file", JSON.stringify({ path: ".env" }))).allowed).toBe(false)
    expect((await p.decide("read_file", JSON.stringify({ path: ".env" }))).allowed).toBe(true)
    expect((await p.decide("read_file", JSON.stringify({ path: ".env" }))).allowed).toBe(true)
    expect(count).toBe(2)
    expect((await p.decide("read_file", JSON.stringify({ path: "keys/.env.production" }))).allowed).toBe(false)
    expect(count).toBe(3)
  })

  test("planning does not block the question - looking at a file is not changing it", async () => {
    const p = new Permissions(async () => "once")
    p.planning = true
    expect((await p.decide("read_file", JSON.stringify({ path: ".env" }))).allowed).toBe(true)
  })

  test("the prompt says which file", () => {
    expect(coverOf("read_file", JSON.stringify({ path: "deploy/.env" }))).toBe("reading deploy/.env")
  })
})

describe("grep never prints a secret file", () => {
  test("it skips them and says so, while ordinary files are searched", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cg-secret-grep-"))
    fs.writeFileSync(path.join(root, ".env"), "API_KEY=sk-live-should-never-show\n")
    fs.writeFileSync(path.join(root, "app.ts"), "const key = process.env.API_KEY\n")
    const result = await runTool("grep", { query: "API_KEY" }, root)
    expect(result).toContain("app.ts:1:")
    expect(result).not.toContain("sk-live-should-never-show")
    expect(result).toContain("not searched, it holds secrets: .env")
  })
})
