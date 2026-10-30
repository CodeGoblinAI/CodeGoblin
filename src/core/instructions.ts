import fs from "node:fs"
import path from "node:path"
import { loadConfig } from "./config"
import { Global } from "../platform/paths"

const isFile = (file: string) => { try { return fs.statSync(file).isFile() } catch { return false } }
const identityOf = (file: string) => { const real = fs.realpathSync(file); return process.platform === "win32" ? real.toLowerCase() : real }

/** The nearest folder at or above this one that holds a .git, or nothing outside a repository. */
function gitRoot(start: string): string | undefined {
  for (let dir = path.resolve(start); ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, ".git"))) return dir
    if (path.dirname(dir) === dir) return undefined
  }
}

/**
 * The instruction files an agent is expected to read without being told.
 *
 * The same ones the fork, Claude Code and Codex read: one global file - the
 * first of <config>/AGENTS.md and ~/.claude/CLAUDE.md - and the project's
 * AGENTS.md files from this folder up to the repository root, outermost first.
 * CLAUDE.md stands in for a project with no AGENTS.md. The walk never goes
 * above the repository (outside one, only this folder is looked at), so a file
 * in the home directory or a parent project does not leak into this one.
 * CODEGOBLIN_DISABLE_INSTRUCTION_FILES=1 turns all of it off.
 *
 * `globals` exists so tests never have to write a file into a home or config
 * directory to exercise the global lookup.
 */
export function discoveredInstructionFiles(root: string, options: { env?: Record<string, string | undefined>; globals?: string[] } = {}): string[] {
  if ((options.env ?? process.env).CODEGOBLIN_DISABLE_INSTRUCTION_FILES === "1") return []
  // No project to look in - a caller that runs the loop without one.
  if (typeof root !== "string" || !root) return []
  const global = (options.globals ?? [path.join(Global.Path.config, "AGENTS.md"), path.join(Global.Path.home, ".claude", "CLAUDE.md")]).find(isFile)
  const start = path.resolve(root)
  const stop = gitRoot(start) ?? start
  for (const name of ["AGENTS.md", "CLAUDE.md"]) {
    const found: string[] = []
    for (let dir = start; ; dir = path.dirname(dir)) {
      if (isFile(path.join(dir, name))) found.push(path.join(dir, name))
      if (path.relative(stop, dir) === "" || path.dirname(dir) === dir) break
    }
    if (found.length) return [...(global ? [global] : []), ...found.reverse()]
  }
  return global ? [global] : []
}

/**
 * The instructions every turn starts with: the discovered files above, then
 * the files codegoblin.jsonc lists. Read fresh each turn, so an edit applies to
 * the next one. Local files only; URLs are never fetched.
 */
export function configuredInstructions(root: string, file?: string): string {
  const config = loadConfig(file)
  if (config.problems.length && config.instructions.length) throw new Error("Cannot load instructions: fix codegoblin.jsonc first")
  const seen = new Set<string>()
  const blocks: string[] = []
  let bytes = 0
  // Not asked for by name, so a file that cannot be used is passed over rather
  // than failing every turn the way a listed one does.
  for (const found of discoveredInstructionFiles(root)) {
    try {
      const identity = identityOf(found)
      const size = fs.statSync(found).size
      if (seen.has(identity) || size > 128 * 1024 || bytes + size > 256 * 1024) continue
      const content = fs.readFileSync(found, "utf8")
      if (content.includes("\0") || !content.trim()) continue
      bytes += size
      seen.add(identity)
      blocks.push("Instructions from " + fs.realpathSync(found) + ":\n" + content)
    } catch { continue }
  }
  for (const entry of config.instructions) {
    if (!entry.trim() || /^\w+:\/\//.test(entry)) throw new Error("Instructions must name local files, not URLs or empty paths")
    const expanded = entry.startsWith("~/") || entry.startsWith("~\\") ? path.join(Global.Path.home, entry.slice(2)) : entry
    const absolute = path.resolve(root, expanded)
    const segments = absolute.replaceAll("\\", "/").split("/")
    const first = segments.findIndex((part) => /[*?{[]/.test(part))
    const base = first < 0 ? path.dirname(absolute) : segments.slice(0, first).join("/") + "/"
    const pattern = first < 0 ? undefined : segments.slice(first).join("/")
    const files: string[] = []
    if (!pattern) files.push(absolute)
    if (pattern) for (const match of new Bun.Glob(pattern).scanSync({ cwd: base, absolute: true, onlyFiles: true, followSymlinks: false })) {
      if (files.length >= 64) throw new Error("Instruction glob exceeds 64 files: " + entry)
      files.push(match)
    }
    files.sort()
    if (!files.length) throw new Error("No instruction files matched: " + entry)
    for (const candidate of files) {
      const resolved = fs.realpathSync(candidate)
      const identity = process.platform === "win32" ? resolved.toLowerCase() : resolved
      if (seen.has(identity)) continue
      const relative = path.relative(fs.realpathSync(base), resolved)
      if (pattern && (relative.startsWith(".." + path.sep) || path.isAbsolute(relative))) throw new Error("Instruction glob escapes its directory: " + entry)
      const stat = fs.statSync(resolved)
      if (!stat.isFile() || stat.size > 128 * 1024 || seen.size >= 64 || bytes + stat.size > 256 * 1024) throw new Error("Instruction files exceed the limit (64 files, 128 KiB each, 256 KiB total): " + entry)
      const content = fs.readFileSync(resolved, "utf8")
      if (content.includes("\0")) throw new Error("Instruction file is not text: " + entry)
      bytes += stat.size
      seen.add(identity)
      blocks.push("Instructions from " + resolved + ":\n" + content)
    }
  }
  return blocks.join("\n\n")
}
