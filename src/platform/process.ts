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
