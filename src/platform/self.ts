import { fileURLToPath } from "node:url"
import { WORKER_FLAGS } from "../cli/route"

/**
 * Whether this is the built program (one file, everything inside it) rather than the source run by Bun.
 * The build sets it; from source it is never set.
 */
export const isCompiled = process.env.CODEGOBLIN_COMPILED === "1"

/**
 * The command that starts a helper copy of this app. From source that is Bun and the helper's file; in the
 * built program there are no files to point at, so the program starts itself with a word only it uses.
 */
export function workerCommand(name: keyof typeof WORKER_FLAGS, source: URL): string[] {
  return isCompiled ? [process.execPath, WORKER_FLAGS[name]] : [process.execPath, fileURLToPath(source)]
}
