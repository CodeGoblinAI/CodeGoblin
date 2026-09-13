import { describe, expect, test } from "bun:test"
import { matchesPattern, mostSpecific } from "../src/core/wildcard"

const BACKSLASH = String.fromCharCode(92)

describe("a permission pattern, matched the way the fork matches it", () => {
  test("a star matches anything, including nothing", () => {
    expect(matchesPattern("rm -rf build", "*rm -rf*")).toBe(true)
    expect(matchesPattern("rm -rf", "*rm -rf*")).toBe(true)
    expect(matchesPattern("echo hi", "*rm -rf*")).toBe(false)
  })

  test("a chained command is caught wherever the pattern appears", () => {
    expect(matchesPattern("git status & rd /s /q dist", "*rd /s*")).toBe(true)
    expect(matchesPattern("powershell -c Remove-Item -Recurse x", "*Remove-Item*")).toBe(true)
  })

  test("on Windows case does not matter, because PowerShell ignores it", () => {
    expect(matchesPattern("remove-item x", "*Remove-Item*", "win32")).toBe(true)
    expect(matchesPattern("remove-item x", "*Remove-Item*", "linux")).toBe(false)
  })

  test("backslashes count as forward slashes", () => {
    expect(matchesPattern("del C:" + BACKSLASH + "temp" + BACKSLASH + "x.txt", "*temp/x*")).toBe(true)
  })

  test("a trailing space-star also covers the bare command", () => {
    expect(matchesPattern("ls", "ls *")).toBe(true)
    expect(matchesPattern("ls -la", "ls *")).toBe(true)
    expect(matchesPattern("lsof", "ls *")).toBe(false)
  })

  test("regex characters in a pattern are literal", () => {
    expect(matchesPattern("a.b", "a.b")).toBe(true)
    expect(matchesPattern("axb", "a.b")).toBe(false)
    expect(matchesPattern("echo (x)", "echo (x)")).toBe(true)
  })

  test("a question mark is exactly one character", () => {
    expect(matchesPattern("rm1", "rm?")).toBe(true)
    expect(matchesPattern("rm", "rm?")).toBe(false)
  })

  test("it is a pattern over text, not a parser - *del * also catches --model", () => {
    // Worth knowing when writing rules: "model " contains "del ", and the
    // trailing " *" also lets it end at "del". Refusing too much is the right
    // way for a deny rule to be wrong, but it is still wrong.
    expect(matchesPattern("bun src/cli/prompt.ts --model x hi", "*del *")).toBe(true)
    expect(matchesPattern("git log --grep=model", "*del *")).toBe(true)
  })
})

describe("when several rules match, the most specific wins", () => {
  test("the longest matching pattern decides", () => {
    const rules = { "*": "deny", "git *": "allow" }
    expect(mostSpecific("git status", rules)).toBe("allow")
    expect(mostSpecific("rm x", rules)).toBe("deny")
  })

  test("no match means no rule", () => {
    expect(mostSpecific("echo hi", { "*rm -rf*": "deny" })).toBeUndefined()
  })
})
