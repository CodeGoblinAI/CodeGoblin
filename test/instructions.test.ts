import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { configuredInstructions } from "../src/core/instructions"
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
  test("rereads changed files; does not look for implicit ancestor instructions", () => {
    const f = fixture()
    fs.writeFileSync(path.join(f.root, "AGENTS.md"), "NOT_CONFIGURED")
    expect(configuredInstructions(f.root, f.config)).toBe("")
    fs.writeFileSync(f.config, '{"instructions":["AGENTS.md"]}')
    expect(configuredInstructions(f.root, f.config)).toContain("NOT_CONFIGURED")
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
