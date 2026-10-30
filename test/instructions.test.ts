import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { configuredInstructions, discoveredInstructionFiles } from "../src/core/instructions"
import { Global } from "../src/platform/paths"
import { requireSandbox } from "./sandbox"
import { runAgent } from "../src/core/agent"

const sandbox = requireSandbox(Global.Path.config, "instruction tests")
const fixture = () => {
  const root = fs.mkdtempSync(path.join(sandbox, "instructions-"))
  const config = path.join(root, "codegoblin.jsonc")
  fs.writeFileSync(config, '{}')
  return { root, config }
}

describe("configured instruction files", () => {
  test("relative paths, absolute paths, globs and duplicate physical files", () => {
    const f = fixture()
    fs.mkdirSync(path.join(f.root, "rules"))
    fs.writeFileSync(path.join(f.root, "rules/a.md"), "USE_A")
    fs.writeFileSync(path.join(f.root, "rules/b.md"), "USE_B")
    fs.writeFileSync(f.config, JSON.stringify({instructions:["rules/*.md", path.join(f.root, "rules/a.md")]}))
    const text = configuredInstructions(f.root, f.config)
    expect(text.match(/USE_A/g)).toHaveLength(1)
    expect(text).toContain("USE_B")
    expect(text.indexOf("USE_A")).toBeLessThan(text.indexOf("USE_B"))
  })
  test("a project AGENTS.md is read without being listed, once even when listed, and reread when edited", () => {
    const f = fixture()
    fs.writeFileSync(path.join(f.root, "AGENTS.md"), "FOUND_WITHOUT_CONFIG")
    expect(configuredInstructions(f.root, f.config)).toContain("FOUND_WITHOUT_CONFIG")
    fs.writeFileSync(f.config, '{"instructions":["AGENTS.md"]}')
    expect(configuredInstructions(f.root, f.config).match(/FOUND_WITHOUT_CONFIG/g)).toHaveLength(1)
    fs.writeFileSync(path.join(f.root, "AGENTS.md"), "UPDATED")
    expect(configuredInstructions(f.root, f.config)).toContain("UPDATED")
  })
  test("missing, remote, binary and oversized rules fail before inference", () => {
    const f = fixture()
    for (const name of ["missing.md", "rules/*.md", "https://example.invalid/rules.md"]) {
      fs.writeFileSync(f.config, JSON.stringify({instructions:[name]}))
      expect(() => configuredInstructions(f.root, f.config)).toThrow()
    }
    fs.writeFileSync(path.join(f.root, "rules.md"), "\0")
    fs.writeFileSync(f.config, '{"instructions":["rules.md"]}')
    expect(() => configuredInstructions(f.root, f.config)).toThrow("not text")
    fs.writeFileSync(path.join(f.root, "rules.md"), "x".repeat(128 * 1024 + 1))
    expect(() => configuredInstructions(f.root, f.config)).toThrow("limit")
  })
  test("AGENTS.md files up to the repository root, outermost first; nothing above it", () => {
    const outside = fs.mkdtempSync(path.join(sandbox, "parent-"))
    fs.writeFileSync(path.join(outside, "AGENTS.md"), "ABOVE_THE_REPO")
    const repo = path.join(outside, "repo")
    const nested = path.join(repo, "packages", "app")
    fs.mkdirSync(nested, { recursive: true })
    fs.mkdirSync(path.join(repo, ".git"))
    fs.writeFileSync(path.join(repo, "AGENTS.md"), "REPO_RULES")
    fs.writeFileSync(path.join(nested, "AGENTS.md"), "APP_RULES")
    fs.writeFileSync(path.join(nested, "CLAUDE.md"), "IGNORED_BESIDE_AGENTS")
    expect(discoveredInstructionFiles(nested).map((file) => path.relative(repo, file))).toEqual(["AGENTS.md", path.join("packages", "app", "AGENTS.md")])
    const text = configuredInstructions(nested, path.join(outside, "missing.jsonc"))
    expect(text.indexOf("REPO_RULES")).toBeLessThan(text.indexOf("APP_RULES"))
    expect(text).not.toContain("ABOVE_THE_REPO")
    expect(text).not.toContain("IGNORED_BESIDE_AGENTS")
    expect(discoveredInstructionFiles(nested, { env: { CODEGOBLIN_DISABLE_INSTRUCTION_FILES: "1" } })).toEqual([])
  })

  // Global files are passed in: a test must never write into a home or config
  // directory, sandboxed or not. One that did would overwrite the real
  // ~/.claude/CLAUDE.md the day the sandbox failed to apply.
  test("one global file, the first that exists; CLAUDE.md only stands in for a missing AGENTS.md", () => {
    const f = fixture()
    const globals = fs.mkdtempSync(path.join(sandbox, "globals-"))
    const agents = path.join(globals, "AGENTS.md")
    const claude = path.join(globals, "CLAUDE.md")
    fs.writeFileSync(claude, "HOME_CLAUDE")
    fs.writeFileSync(path.join(f.root, "CLAUDE.md"), "CLAUDE_PROJECT")
    expect(discoveredInstructionFiles(f.root, { globals: [agents, claude] })).toEqual([claude, path.join(f.root, "CLAUDE.md")])
    fs.writeFileSync(agents, "GLOBAL_AGENTS")
    fs.writeFileSync(path.join(f.root, "AGENTS.md"), "PROJECT_AGENTS")
    expect(discoveredInstructionFiles(f.root, { globals: [agents, claude] })).toEqual([agents, path.join(f.root, "AGENTS.md")])
  })

  test("a discovered file that cannot be used is skipped, not a failure every turn", () => {
    const f = fixture()
    fs.writeFileSync(path.join(f.root, "AGENTS.md"), "x".repeat(128 * 1024 + 1))
    expect(() => configuredInstructions(f.root, f.config)).not.toThrow()
    expect(configuredInstructions(f.root, f.config)).toBe("")
    fs.writeFileSync(path.join(f.root, "AGENTS.md"), "binary\0content")
    expect(configuredInstructions(f.root, f.config)).toBe("")
  })

  test("shared agent transport includes configured rules without storing them in history", async () => {
    fs.mkdirSync(Global.Path.config, {recursive:true})
    const config = path.join(Global.Path.config, "codegoblin.jsonc")
    const original = fs.existsSync(config) ? fs.readFileSync(config, "utf8") : "{}"
    const f = fixture()
    fs.writeFileSync(path.join(f.root,"rules.md"), "REAL_CONFIGURED_RULE")
    fs.writeFileSync(config, '{"instructions":["rules.md"]}')
    const messages = [{role:"user" as const,content:"hello"}]
    try {
      for await (const _ of runAgent({provider:{id:"fixture", label:"Fixture",cli:"codex",models:[]},modelId:"fixture",apiKey:"",root:f.root,messages,
        completion:async function* (input) {
          expect(input.messages[0]?.role).toBe("system")
          expect(input.messages[0]?.content).toContain("REAL_CONFIGURED_RULE")
          yield {type:"text",delta:"done"}
        }})) {}
      expect(JSON.stringify(messages)).not.toContain("REAL_CONFIGURED_RULE")
    } finally { fs.writeFileSync(config, original) }
  })
})
