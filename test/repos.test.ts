import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { inRepoCache, parseRepo, repoHome, repoOverview } from "../src/core/repos"
import { runTool } from "../src/core/tools"
import { Permissions, askedFor } from "../src/core/permission"

/** A folder where repo_clone would have put octo/hello. */
function fakeClone(): string {
  const folder = parseRepo("octo/hello").folder
  fs.mkdirSync(path.join(folder, "src"), { recursive: true })
  fs.writeFileSync(path.join(folder, "package.json"), JSON.stringify({ main: "dist/index.js", scripts: { build: "tsc", test: "bun test" } }))
  fs.writeFileSync(path.join(folder, "bun.lock"), "")
  fs.writeFileSync(path.join(folder, "README.md"), "# hello\n")
  fs.writeFileSync(path.join(folder, "src", "index.ts"), "export const greet = () => 'hello'\n")
  return folder
}

describe("repository references", () => {
  test("owner/repo, host/owner/repo and https URLs; anything else refused", () => {
    expect(parseRepo("octo/hello")).toMatchObject({ url: "https://github.com/octo/hello.git", host: "github.com", owner: "octo", name: "hello" })
    expect(parseRepo("gitlab.com/group/tool").url).toBe("https://gitlab.com/group/tool.git")
    expect(parseRepo("https://codeberg.org/a/b.git").folder).toBe(path.join(repoHome(), "codeberg.org", "a", "b"))
    for (const bad of ["git@github.com:a/b.git", "file:///etc", "a/b/c", "../x/y", "just-a-name"]) expect(() => parseRepo(bad)).toThrow()
  })
})

describe("reading a cloned repository", () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "cg-repos-project-"))

  test("the read tools may read inside the clone folder, and nowhere else outside the project", async () => {
    const folder = fakeClone()
    expect(inRepoCache(path.join(folder, "README.md"))).toBe(true)
    expect(await runTool("read_file", { path: path.join(folder, "src", "index.ts") }, project)).toContain("greet")
    expect(await runTool("list_files", { path: folder }, project)).toContain("src/")
    expect(await runTool("grep", { query: "greet", path: folder }, project)).toContain("src/index.ts:1:")
    expect(await runTool("glob", { pattern: "**/*.ts", path: folder }, project)).toContain("src/index.ts")
    expect(await runTool("read_file", { path: path.join(os.tmpdir(), "elsewhere.txt") }, project)).toContain("escapes the working directory")
    expect(inRepoCache(path.join(repoHome(), "..", "auth.json"))).toBe(false)
  })

  test("writing tools still stay inside the project", async () => {
    const folder = fakeClone()
    expect(await runTool("write_file", { path: path.join(folder, "x.txt"), content: "no" }, project)).toContain("escapes the working directory")
    expect(fs.existsSync(path.join(folder, "x.txt"))).toBe(false)
  })

  test("repo_overview says what a repository is and where to start", async () => {
    fakeClone()
    const overview = await runTool("repo_overview", { target: "octo/hello" }, project)
    expect(overview).toContain("ecosystems: JavaScript/TypeScript")
    expect(overview).toContain("package manager: bun")
    expect(overview).toContain("scripts: build, test")
    expect(overview).toContain("likely entry points: dist/index.js, src/index.ts")
    expect(overview).toContain("docs: README.md")
    expect(repoOverview(project)).toContain("ecosystems: none recognised")
    expect(await runTool("repo_overview", { target: "nobody/nothing" }, project)).toContain("repo_clone it first")
  })
})

describe("asking", () => {
  test("repo_clone asks, naming the repository; repo_overview never does", async () => {
    const asked: string[] = []
    const permissions = new Permissions(async (tool, detail) => { asked.push(askedFor(tool, detail)); return "once" })
    await permissions.decide("repo_clone", JSON.stringify({ repository: "octo/hello" }))
    await permissions.decide("repo_overview", JSON.stringify({ target: "octo/hello" }))
    expect(asked).toEqual(["octo/hello"])
    permissions.planning = true
    expect((await permissions.decide("repo_clone", JSON.stringify({ repository: "octo/hello" }))).allowed).toBe(true)
  })
})
