import fs from "node:fs"
import path from "node:path"
import { loadConfig } from "./config"
import { Global } from "../platform/paths"

/** Only explicitly configured local files; never fetch URLs or walk ancestors. */
export function configuredInstructions(root: string, file?: string): string {
  const config = loadConfig(file)
  if (config.problems.length && config.instructions.length) throw new Error("Cannot load instructions: fix codegoblin.jsonc first")
  const seen = new Set<string>()
  const blocks: string[] = []
  let bytes = 0
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
