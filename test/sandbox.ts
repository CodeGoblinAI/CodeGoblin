import path from "node:path"

/**
 * The directory test/preload.ts made for this run - or a thrown error, if
 * there is no such directory or `file` is not inside it.
 *
 * Call it at the top of any test file that writes state, with the file it is
 * about to write, before the first write. The preload is what keeps a run away
 * from the real profile; this is what stops a file cold when the preload did
 * not run, instead of letting it loose on the real keys.
 */
export function requireSandbox(file: string, who: string): string {
  const sandbox = process.env.CODEGOBLIN_TEST_SANDBOX
  if (!sandbox || !path.resolve(file).startsWith(path.resolve(sandbox) + path.sep)) {
    throw new Error(
      `refusing to run ${who}: ${file} is not inside a test sandbox. ` +
        "Run the tests from the repo root with npm test, so test/preload.ts sets one up first.",
    )
  }
  return sandbox
}
