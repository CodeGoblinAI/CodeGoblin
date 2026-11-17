import { expect, test } from "bun:test"
import { runForeground } from "../src/core/jobs"
import { shellEnvironment } from "../src/core/tools"

/**
 * Text that is not ASCII, through a command and back. Decoded a chunk at a time, a character split between
 * two chunks became two replacement marks; Python on a machine with an older code page stopped at the first
 * name it could not spell.
 */
test("a long output of accented, Japanese and emoji text comes back whole", async () => {
  const out = await runForeground(`node -e "process.stdout.write('\\u00e9\\u65e5\\ud83c\\udf89'.repeat(120000))"`, process.cwd(), { timeoutMs: 30000 })
  expect(out.includes("�")).toBe(false)
  expect(out.length).toBe(120000 * 4)
}, 40000)

test("python is told to write UTF-8, unless the person chose otherwise", () => {
  expect(shellEnvironment({ PATH: "x" }).PYTHONIOENCODING).toBe("utf-8")
  expect(shellEnvironment({ PATH: "x", PYTHONIOENCODING: "latin-1" }).PYTHONIOENCODING).toBe("latin-1")
})
