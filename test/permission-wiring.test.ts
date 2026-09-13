import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"

/**
 * The surfaces build Permissions with the config rules, and nothing else in the
 * app builds one at all.
 *
 * A bare `new Permissions(ask)` sees no rules - on purpose, so tests are not
 * governed by whoever runs them. That makes forgetting the rules silent: the
 * app would simply stop honouring every deny in codegoblin.jsonc, which is the
 * gap this closed. Reading the source is the cheapest way to make it loud.
 */
const root = path.join(import.meta.dir, "..", "src")

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return sourceFiles(full)
    return entry.name.endsWith(".ts") || entry.name.endsWith(".js") ? [full] : []
  })
}

describe("where permissions are built", () => {
  test("the terminal and the browser both use the config rules", () => {
    for (const file of ["tui/app.ts", "web/consent.ts"]) {
      const text = fs.readFileSync(path.join(root, file), "utf8")
      expect([file, text.includes("Permissions.withConfig(")]).toEqual([file, true])
    }
  })

  test("the web server takes its permissions from there rather than building its own", () => {
    const text = fs.readFileSync(path.join(root, "web", "serve.ts"), "utf8")
    expect(text.includes("consent.forSession(")).toBe(true)
  })

  test("no app code builds Permissions without them", () => {
    const own = path.join(root, "core", "permission.ts")
    const offenders = sourceFiles(root)
      .filter((file) => file !== own)
      .filter((file) => fs.readFileSync(file, "utf8").includes("new Permissions("))
      .map((file) => path.relative(root, file))
    expect(offenders).toEqual([])
  })
})
