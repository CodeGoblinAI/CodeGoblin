import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const VITE_MIN = [
  { major: 20, minor: 19 },
  { major: 22, minor: 12 },
] as const

export function parseNodeVersion(version: string) {
  const match = version.trim().match(/v?(\d+)\.(\d+)\.(\d+)/)
  if (!match) return
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) }
}

export function nodeSupportsVite(version: string) {
  const parsed = parseNodeVersion(version)
  if (!parsed) return false
  if (parsed.major > 22) return true
  if (parsed.major === 22) return parsed.minor >= VITE_MIN[1].minor
  if (parsed.major === 21) return true
  if (parsed.major === 20) return parsed.minor >= VITE_MIN[0].minor
  return false
}

function nodeVersionAt(nodePath: string) {
  if (!fs.existsSync(nodePath)) return
  const result = spawnSync(nodePath, ["-v"], { encoding: "utf8" })
  if (result.status !== 0) return
  return result.stdout.trim()
}

function nodeExecutablesOnPath() {
  const cmd = process.platform === "win32" ? "where.exe" : "which"
  const result = spawnSync(cmd, ["node"], { encoding: "utf8", shell: process.platform === "win32" })
  if (result.status !== 0) return [] as string[]
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
}

function nodeSearchDirs() {
  const home = os.homedir()
  const dirs = [
    process.env.CODEGOBLIN_NODE_BIN ? path.dirname(process.env.CODEGOBLIN_NODE_BIN) : "",
    path.join(home, ".cache", "codex-runtimes", "codex-primary-runtime", "dependencies", "node", "bin"),
    path.join(home, ".fnm", "aliases", "default", "bin"),
    process.env.FNM_DIR ? path.join(process.env.FNM_DIR, "aliases", "default", "bin") : "",
    process.env.NVM_BIN ?? "",
    process.platform === "win32" ? path.join(process.env.ProgramFiles ?? "", "nodejs") : "",
  ].filter(Boolean)

  if (process.platform === "win32" && process.env.NVM_HOME && fs.existsSync(process.env.NVM_HOME)) {
    for (const entry of fs.readdirSync(process.env.NVM_HOME, { withFileTypes: true })) {
      if (entry.isDirectory() && /^v?\d/.test(entry.name)) {
        dirs.push(path.join(process.env.NVM_HOME!, entry.name))
      }
    }
  }

  return [...new Set(dirs)]
}

/** Absolute path to a Node executable that satisfies Vite 7. */
export function resolveViteNodeExecutable(): string {
  const explicit = process.env.CODEGOBLIN_NODE_BIN
  if (explicit) {
    const version = nodeVersionAt(explicit)
    if (version && nodeSupportsVite(version)) return path.resolve(explicit)
    throw new Error(
      `CODEGOBLIN_NODE_BIN=${explicit} (${version ?? "unknown"}) does not satisfy Vite 7 (needs Node 20.19+ or 22.12+).`,
    )
  }

  const seen = new Set<string>()
  const candidates = [
    ...nodeExecutablesOnPath(),
    ...nodeSearchDirs().map((dir) => path.join(dir, process.platform === "win32" ? "node.exe" : "node")),
  ]

  for (const candidate of candidates) {
    const normalized = path.resolve(candidate)
    if (seen.has(normalized)) continue
    seen.add(normalized)
    const version = nodeVersionAt(normalized)
    if (version && nodeSupportsVite(version)) return normalized
  }

  const firstOnPath = nodeExecutablesOnPath()[0]
  const firstVersion = firstOnPath ? nodeVersionAt(firstOnPath) : undefined
  throw new Error(
    [
      "No Node.js found that satisfies Vite 7 (needs 20.19+ or 22.12+).",
      firstVersion ? `Default PATH node: ${firstVersion}` : "No node on PATH.",
      "Install a newer Node, or set CODEGOBLIN_NODE_BIN to a compatible node executable.",
      "Note: bun run vite uses Bun's Node shim (20.11) — web builds must invoke node directly.",
    ].join("\n"),
  )
}

export function viteBuildEnv(nodeExecutable: string): NodeJS.ProcessEnv {
  const nodeDir = path.dirname(nodeExecutable)
  const pathKey = process.platform === "win32" ? "Path" : "PATH"
  const current = process.env[pathKey] ?? process.env.PATH ?? ""
  return {
    ...process.env,
    [pathKey]: `${nodeDir}${path.delimiter}${current}`,
  }
}

export function logViteNodeChoice(nodeExecutable: string) {
  const version = nodeVersionAt(nodeExecutable)
  const firstOnPath = nodeExecutablesOnPath()[0]
  const firstVersion = firstOnPath ? nodeVersionAt(firstOnPath) : undefined
  if (firstOnPath && path.resolve(firstOnPath) === path.resolve(nodeExecutable)) return
  console.log(
    `Using Node ${version ?? "unknown"} for web UI build${firstVersion ? ` (default PATH has ${firstVersion})` : ""}.`,
  )
}

export function viteCliPath(appDir: string) {
  const direct = path.join(appDir, "node_modules", "vite", "bin", "vite.js")
  if (fs.existsSync(direct)) return direct
  throw new Error(`Vite CLI not found under ${appDir}. Run bun install in the repo root.`)
}
