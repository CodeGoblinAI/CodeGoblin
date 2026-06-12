#!/usr/bin/env bun
/**
 * Run CodeGoblin from the current branch without npm link.
 *
 * Usage (from repo root):
 *   bun run cg:branch              → TUI
 *   bun run cg:branch web          → web UI (full build, embeds app)
 *   bun run cg:branch status       → any cg subcommand
 *   bun run cg:branch --rebuild    → force rebuild first
 *
 * cg:branch uses a stable session DB (opencode-dev.db by default) so sessions
 * survive branch rebuilds. Override with CODEGOBLIN_DB if needed.
 */
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { logViteNodeChoice, resolveViteNodeExecutable, viteBuildEnv } from "./resolve-vite-node.ts"

const root = path.resolve(import.meta.dirname, "..")
const rawArgs = process.argv.slice(2)
const rebuild = rawArgs.includes("--rebuild")
const args = rawArgs.filter((item) => item !== "--rebuild")

function platformBinDir() {
  const platform = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "darwin" : "linux"
  const arch = process.arch === "arm64" ? "arm64" : "x64"
  return path.join(root, "packages", "codegoblin", "dist", `codegoblin-${platform}-${arch}`, "bin")
}

function binaryPath() {
  const name = process.platform === "win32" ? "opencode.exe" : "opencode"
  return path.join(platformBinDir(), name)
}

function run(cmd: string, cmdArgs: string[], cwd = root, env?: NodeJS.ProcessEnv) {
  const result = spawnSync(cmd, cmdArgs, {
    cwd,
    stdio: "inherit",
    shell: process.platform === "win32",
    env,
  })
  if (result.status !== 0) process.exit(result.status ?? 1)
}

const wantsWeb = args[0] === "web"
const buildScript = wantsWeb ? "build:cli" : "build:cli:fast"
const bin = binaryPath()

if (rebuild || !fs.existsSync(bin)) {
  console.log(`Building CodeGoblin from this branch (${buildScript})…`)
  let env = process.env
  if (wantsWeb) {
    try {
      const node = resolveViteNodeExecutable()
      logViteNodeChoice(node)
      env = viteBuildEnv(node)
    } catch (error) {
      console.error(error instanceof Error ? error.message : error)
      process.exit(1)
    }
  }
  run(process.platform === "win32" ? "npm.cmd" : "npm", ["run", buildScript], root, env)
}

if (!fs.existsSync(bin)) {
  console.error(`Binary not found after build: ${bin}`)
  process.exit(1)
}

const runArgs = args.length ? args : []
const branchEnv = {
  ...process.env,
  // Keep cg:branch sessions in one DB instead of a new file per git branch at build time.
  CODEGOBLIN_DB: process.env.CODEGOBLIN_DB ?? process.env.OPENCODE_DB ?? "opencode-dev.db",
}
if (!process.env.CODEGOBLIN_DB && !process.env.OPENCODE_DB) {
  console.log(`Using stable session database: ${branchEnv.CODEGOBLIN_DB}`)
}
const result = spawnSync(bin, runArgs, { stdio: "inherit", cwd: process.cwd(), env: branchEnv })
process.exit(result.status ?? 0)
