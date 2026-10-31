import fs from "node:fs"
import path from "node:path"
import { Global } from "../platform/paths"

/**
 * Projects the browser has worked in, so it can switch between them.
 *
 * The fork's web app has a project switcher; the terminal does not need one,
 * because a terminal is started in a folder. The list is a convenience only:
 * a folder that no longer exists drops out, and nothing here is trusted to
 * be anything but a path the person chose.
 */
export type Project = { path: string; name: string; opened: number }

const file = () => path.join(Global.Path.state, "projects.json")
const KEPT = 20
const same = (a: string, b: string) => (process.platform === "win32" ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b))

export function isDirectory(target: string): boolean {
  try { return fs.statSync(target).isDirectory() } catch { return false }
}

function read(): Project[] {
  try {
    const raw = JSON.parse(fs.readFileSync(file(), "utf8")) as unknown
    if (!Array.isArray(raw)) return []
    return raw.filter((entry): entry is Project => Boolean(entry) && typeof entry.path === "string" && path.isAbsolute(entry.path) && typeof entry.opened === "number")
      .map((entry) => ({ path: entry.path, name: path.basename(entry.path) || entry.path, opened: entry.opened }))
  } catch {
    return []
  }
}

/** Recent projects that still exist, most recently opened first. */
export function recentProjects(): Project[] {
  return read().filter((project) => isDirectory(project.path)).sort((a, b) => b.opened - a.opened)
}

/** Remembers a folder as just opened. */
export function rememberProject(folder: string, now = Date.now()): Project[] {
  const resolved = path.resolve(folder)
  const next = [{ path: resolved, name: path.basename(resolved) || resolved, opened: now }, ...read().filter((project) => !same(project.path, resolved))].slice(0, KEPT)
  try {
    fs.mkdirSync(path.dirname(file()), { recursive: true })
    fs.writeFileSync(file(), JSON.stringify(next, null, 2))
  } catch {
    // A list that cannot be saved is not worth interrupting anyone over.
  }
  return next
}

/** Whether two paths are the same folder, the way this platform compares them. */
export const sameFolder = same
