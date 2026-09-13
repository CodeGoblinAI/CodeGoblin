import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { parseConfig, loadConfig } from "../src/core/config"

describe("reading codegoblin.jsonc", () => {
  test("rules come through as written, comments and trailing commas included", () => {
    const config = parseConfig(`{
      // the fork writes comments into this file
      "$schema": "https://example.invalid/config.json",
      "permission": { "bash": { "*rm -rf*": "deny", "*Remove-Item*": "deny" } },
      "instructions": ["C:/Users/someone/AGENTS.md"],
    }`)
    expect(config.permission.bash).toEqual({ "*rm -rf*": "deny", "*Remove-Item*": "deny" })
    expect(config.instructions).toEqual(["C:/Users/someone/AGENTS.md"])
    expect(config.problems).toEqual([])
  })

  test("a single action for all of bash means every command", () => {
    expect(parseConfig(`{ "permission": { "bash": "deny" } }`).permission.bash).toEqual({ "*": "deny" })
  })

  test("an action nobody defined is dropped rather than guessed at", () => {
    const config = parseConfig(`{ "permission": { "bash": { "*rm*": "forbid", "*del *": "deny", "": "deny" } } }`)
    expect(config.permission.bash).toEqual({ "*del *": "deny" })
  })

  test("MCP servers in the fork's shape, and nothing that is not one", () => {
    const config = parseConfig(`{
      "mcp": {
        "files": { "type": "local", "command": ["npx", "-y", "server-filesystem", "."], "environment": { "A": "1", "B": 2 } },
        "docs": { "type": "remote", "url": "https://example.invalid/mcp", "headers": { "Authorization": "Bearer x" }, "enabled": false, "timeout": 5000 },
        "broken": { "type": "local", "command": [] },
        "odd": { "type": "carrier-pigeon" }
      }
    }`)
    expect(config.mcp.files).toEqual({
      type: "local",
      command: ["npx", "-y", "server-filesystem", "."],
      environment: { A: "1" },
      enabled: true,
    })
    expect(config.mcp.docs).toEqual({
      type: "remote",
      url: "https://example.invalid/mcp",
      headers: { Authorization: "Bearer x" },
      enabled: false,
      timeout: 5000,
    })
    expect(Object.keys(config.mcp)).toEqual(["files", "docs"])
  })

  test("a file that will not parse says so instead of looking empty", () => {
    const config = parseConfig(`{ "permission": { "bash": { "*rm -rf*": "deny" `)
    expect(config.problems.length).toBeGreaterThan(0)
  })

  test("no file at all is an empty config, not an error", () => {
    const missing = path.join(os.tmpdir(), "cg-config-" + Math.random().toString(36).slice(2), "codegoblin.jsonc")
    const config = loadConfig(missing)
    expect(config.permission.bash).toEqual({})
    expect(config.problems).toEqual([])
  })

  test("a file on disk is read", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cg-config-"))
    const file = path.join(dir, "codegoblin.jsonc")
    fs.writeFileSync(file, `{ "permission": { "bash": { "*rimraf*": "deny" } } }`)
    expect(loadConfig(file).permission.bash).toEqual({ "*rimraf*": "deny" })
  })
})
