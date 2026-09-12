import fs from "node:fs"
import os from "node:os"
import path from "node:path"

/**
 * Every test run gets a home of its own, set before any test file loads.
 *
 * paths.ts works out its directories once, the first time anything imports
 * it. Test files used to point it somewhere safe at their own top, which held
 * only while nothing earlier in the run had already imported it with the real
 * home. On 2026-09-12 a new test did. The auth tests then wrote into the real
 * key store - connecting fake keys, corrupting the file on purpose, repairing
 * it - and emptied the keys this app and the fork both use. The memory tests
 * cleared the real memory.json in the same run. A test noticed afterwards.
 *
 * Setting CODEGOBLIN_DIR here, before anything imports paths.ts, moves every
 * directory for the whole run whichever file happens to load first. The check
 * below stops the run outright if that is ever not true, so the next time
 * something goes wrong it goes wrong before a single write rather than after.
 */
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "cg-test-home-"))
process.env.CODEGOBLIN_DIR = sandbox
process.env.CODEGOBLIN_TEST_HOME = sandbox
// Tests that change the two above to exercise paths.ts cannot move this one,
// so test/sandbox.ts always knows where this run's sandbox really is.
process.env.CODEGOBLIN_TEST_SANDBOX = sandbox
for (const name of ["XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME"]) {
  delete process.env[name]
}

const { Global } = await import("../src/platform/paths")

const within = (dir: string) => path.resolve(dir).startsWith(path.resolve(sandbox) + path.sep)
const escaped = (["data", "cache", "config", "state"] as const).filter((name) => !within(Global.Path[name]))

if (escaped.length) {
  throw new Error(
    "refusing to run the tests: " +
      escaped.join(", ") +
      " resolved outside the test sandbox " +
      sandbox +
      ". Something imported paths.ts before this preload ran, so a test could write to the real profile.",
  )
}
