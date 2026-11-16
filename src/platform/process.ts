import { spawn as nodeSpawn, type SpawnOptions } from "node:child_process"

/**
 * Replaces @/util/process.
 *
 * windowsHide defaults ON. A Bun/Node spawn without it opens a console window
 * on Windows only, so it passes CI and Unix review and surfaces as a terminal
 * flashing on the user's desktop. That bug cost real debugging time in the
 * previous codebase; make it impossible here by construction.
 */
export function spawn(command: string[], opts: SpawnOptions = {}) {
  const [exe, ...args] = command
  return nodeSpawn(exe!, args, { windowsHide: true, ...opts })
}

/**
 * A command line for the platform's shell, with the options it has to be started with.
 *
 * On Windows the command goes to cmd.exe exactly as written. It used to be passed as an ordinary argument,
 * and an argument is quoted the way C programs expect: every double quote in it gets a backslash in front.
 * cmd.exe does not read that. `mkdir "My Files"` reached it with backslashes before both quotes and made a
 * folder with a quote in its name, `echo "hi"` printed the backslashes, and a path with a space in it could
 * not be named at all. A real "move this folder" took a model five minutes and thirty-three steps, nine of
 * them failures, working round it with short 8.3 names. `/s /c "<command>"` with verbatim arguments is the
 * form cmd.exe documents: it drops the outer pair of quotes and runs the rest untouched.
 */
export function shellCommand(command: string, platform: string = process.platform): { argv: string[]; options: SpawnOptions } {
  if (platform !== "win32") return { argv: ["/bin/sh", "-c", command], options: {} }
  return { argv: ["cmd.exe", "/d", "/s", "/c", '"' + command + '"'], options: { windowsVerbatimArguments: true } }
}

/** Namespace form, matching how the domain code imports it. */
export const Process = { spawn }
