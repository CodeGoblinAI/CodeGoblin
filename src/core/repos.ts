import fs from "node:fs"
import path from "node:path"
import { spawn } from "node:child_process"
import { Global } from "../platform/paths"

/**
 * Other people's code, for reference: the fork's repo_clone and repo_overview.
 *
 * A model asked how a library does something reads the library rather than
 * guessing. repo_clone makes a shallow clone into CG-Next's own data folder -
 * never the project - and the read-only tools (read_file, list_files, grep,
 * glob) may read there. Nothing can write there but repo_clone itself, and
 * cloning asks first, since it reaches the network.
 */
export const repoHome = () => path.join(Global.Path.data, "repos")

export type RepoRef = { url: string; host: string; owner: string; name: string; folder: string }

/** "owner/repo", "github.com/owner/repo", or an https URL, to a clone URL and a folder. */
export function parseRepo(reference: string): RepoRef {
  const text = reference.trim().replace(/\.git$/, "").replace(/\/+$/, "")
  let host = "github.com"
  let rest = text
  const url = /^https:\/\/([^/\s]+)\/(.+)$/.exec(text)
  if (url) { host = url[1]!.toLowerCase(); rest = url[2]! }
  else if (/^[a-z0-9.-]+\.[a-z]{2,}\//i.test(text)) { host = text.slice(0, text.indexOf("/")).toLowerCase(); rest = text.slice(text.indexOf("/") + 1) }
  else if (/^(http|git|ssh|file):/i.test(text) || text.includes("@")) throw new Error("give an https URL, host/owner/repo, or owner/repo")
  const parts = rest.split("/").filter(Boolean)
  if (parts.length !== 2) throw new Error("a repository is owner/repo (and optionally its host)")
  const [owner, name] = parts as [string, string]
  const safe = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/
  if (!safe.test(owner) || !safe.test(name) || !/^[a-z0-9.-]{1,100}$/.test(host)) throw new Error("that does not look like a repository name")
  return { url: `https://${host}/${owner}/${name}.git`, host, owner, name, folder: path.join(repoHome(), host, owner, name) }
}

/** Whether an absolute path is inside the clone cache - the one place outside the project read tools may look. */
export function inRepoCache(target: string): boolean {
  if (!path.isAbsolute(target)) return false
  const resolved = path.resolve(target)
  const home = path.resolve(repoHome())
  const relative = path.relative(home, resolved)
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return false
  // Through a link it could be anywhere. Walk from the target up to the cache
  // root; any broken link along the way is refused rather than trusted.
  try {
    const realHome = fs.realpathSync(home)
    let at = resolved
    let realTarget: string | undefined
    for (;;) {
      try {
        realTarget = path.join(fs.realpathSync(at), path.relative(at, resolved))
        break
      } catch {
        try {
          fs.lstatSync(at)
          return false
        } catch {}
        const up = path.dirname(at)
        if (up === at) return false
        at = up
      }
    }
    const again = path.relative(realHome, realTarget)
    return Boolean(again) && !again.startsWith("..") && !path.isAbsolute(again)
  } catch {
    return false
  }
}

function git(args: string[], cwd: string | undefined, signal?: AbortSignal, timeout = 180_000): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    const child = spawn("git", args, { cwd, windowsHide: true, signal, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } })
    let output = ""
    const timer = setTimeout(() => child.kill(), timeout)
    child.stdout.on("data", (chunk) => { output = (output + chunk).slice(-2000) })
    child.stderr.on("data", (chunk) => { output = (output + chunk).slice(-2000) })
    child.on("error", (error) => { clearTimeout(timer); resolve({ ok: false, output: error.message }) })
    child.on("close", (code) => { clearTimeout(timer); resolve({ ok: code === 0, output }) })
  })
}

/** Clones (shallow) or, asked to, refreshes a repository; returns where it is. */
export async function cloneRepo(reference: string, options: { refresh?: boolean; branch?: string; signal?: AbortSignal } = {}): Promise<string> {
  const repo = parseRepo(reference)
  if (options.branch !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/.test(options.branch)) throw new Error("not a branch name")
  if (fs.existsSync(path.join(repo.folder, ".git"))) {
    if (!options.refresh) return `already cloned: ${repo.folder}`
    const fetched = await git(["fetch", "--depth", "1", "origin", options.branch ?? "HEAD"], repo.folder, options.signal)
    if (!fetched.ok) throw new Error("git could not refresh it: " + fetched.output.trim().split(/\r?\n/).at(-1))
    // The cache is CG-Next's own copy; nothing of the user's lives in it.
    await git(["reset", "--hard", "FETCH_HEAD"], repo.folder, options.signal)
    return `refreshed: ${repo.folder}`
  }
  fs.mkdirSync(path.dirname(repo.folder), { recursive: true })
  const cloned = await git(["clone", "--depth", "1", "--single-branch", ...(options.branch ? ["--branch", options.branch] : []), repo.url, repo.folder], undefined, options.signal)
  if (!cloned.ok) throw new Error("git could not clone it: " + cloned.output.trim().split(/\r?\n/).at(-1))
  return `cloned: ${repo.folder}`
}

const ECOSYSTEMS: [string, string][] = [
  ["package.json", "JavaScript/TypeScript"], ["pyproject.toml", "Python"], ["requirements.txt", "Python"], ["setup.py", "Python"],
  ["Cargo.toml", "Rust"], ["go.mod", "Go"], ["pom.xml", "Java (Maven)"], ["build.gradle", "JVM (Gradle)"], ["build.gradle.kts", "JVM (Gradle)"],
  ["Gemfile", "Ruby"], ["composer.json", "PHP"], ["mix.exs", "Elixir"], ["pubspec.yaml", "Dart/Flutter"], ["CMakeLists.txt", "C/C++ (CMake)"],
  ["Package.swift", "Swift"], ["deno.json", "Deno"],
]
const LOCKS: [string, string][] = [["bun.lock", "bun"], ["bun.lockb", "bun"], ["pnpm-lock.yaml", "pnpm"], ["yarn.lock", "yarn"], ["package-lock.json", "npm"], ["uv.lock", "uv"], ["poetry.lock", "poetry"], ["Cargo.lock", "cargo"]]
const SKIP = new Set([".git", "node_modules", "dist", "build", "target", ".next", "vendor", "__pycache__"])

/** Ecosystems, package manager, likely entry points and a short tree, for orienting in a repository. */
export function repoOverview(folder: string): string {
  const has = (file: string) => fs.existsSync(path.join(folder, file))
  const lines: string[] = [folder]
  const ecosystems = [...new Set(ECOSYSTEMS.filter(([file]) => has(file)).map(([, name]) => name))]
  lines.push("ecosystems: " + (ecosystems.join(", ") || "none recognised"))
  const managers = [...new Set(LOCKS.filter(([file]) => has(file)).map(([, name]) => name))]
  if (managers.length) lines.push("package manager: " + managers.join(", "))
  const entry: string[] = []
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(folder, "package.json"), "utf8")) as { main?: unknown; module?: unknown; bin?: unknown; scripts?: Record<string, unknown> }
    for (const field of [pkg.main, pkg.module]) if (typeof field === "string") entry.push(field)
    if (typeof pkg.bin === "string") entry.push(pkg.bin)
    else if (pkg.bin && typeof pkg.bin === "object") entry.push(...Object.values(pkg.bin as Record<string, unknown>).filter((v): v is string => typeof v === "string"))
    if (pkg.scripts) lines.push("scripts: " + Object.keys(pkg.scripts).slice(0, 12).join(", "))
  } catch {}
  for (const candidate of ["src/index.ts", "src/main.ts", "src/index.js", "index.js", "main.py", "src/main.rs", "src/lib.rs", "main.go", "cmd", "app.py", "manage.py"]) if (has(candidate)) entry.push(candidate)
  if (entry.length) lines.push("likely entry points: " + [...new Set(entry)].join(", "))
  for (const doc of ["README.md", "README", "CONTRIBUTING.md", "AGENTS.md", "CLAUDE.md"]) if (has(doc)) { lines.push("docs: " + doc); break }
  lines.push("", "layout:")
  const walk = (dir: string, depth: number, prefix: string) => {
    let entries: fs.Dirent[]
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    const shown = entries.filter((e) => !SKIP.has(e.name) && !(e.name.startsWith(".") && e.name !== ".github")).sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
    for (const e of shown.slice(0, 25)) {
      lines.push(prefix + e.name + (e.isDirectory() ? "/" : ""))
      if (e.isDirectory() && depth < 1) walk(path.join(dir, e.name), depth + 1, prefix + "  ")
    }
    if (shown.length > 25) lines.push(prefix + `... ${shown.length - 25} more`)
  }
  walk(folder, 0, "  ")
  return lines.join("\n")
}
