import { expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"

/**
 * The surfaces' entry files are never imported by a test - importing one
 * starts a server or takes the terminal - so a syntax error in one passed the
 * suite and only showed when the app was launched. `a ?? b && c` did exactly
 * that on 2026-10-30, and typecheck did not flag it. Parsing is enough to catch it.
 */
for (const file of ["src/web/serve.ts", "src/tui/app.ts", "src/cli/prompt.ts", "src/web/app.js"]) {
  test("parses: " + file, () => {
    const source = fs.readFileSync(path.join(import.meta.dir, "..", file), "utf8")
    const loader = file.endsWith(".js") ? "js" : "ts"
    expect(() => new Bun.Transpiler({ loader }).transformSync(source)).not.toThrow()
  })
}
