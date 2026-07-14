import { spawn } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { errorMessage } from "@/util/error"
import type { Method } from "."

const HELPER_ARGUMENT = "--codegoblin-update-helper"
const HELPER_ENV = "CODEGOBLIN_UPDATE_HELPER"
const CLEANUP_ENV = "CODEGOBLIN_UPDATE_CLEANUP"
const ERROR_ENV = "CODEGOBLIN_UPDATE_ERROR"

export type WindowsUpdateState = {
  parentPID: number
  installedPath: string
  helperPath: string
  directory: string
  cwd: string
  restartArgs: string[]
  method: Method
  target: string
}

export function needsWindowsUpdateHandoff(input: {
  method: Method
  platform?: NodeJS.Platform
  execPath?: string
  helper?: string
}) {
  if ((input.platform ?? process.platform) !== "win32") return false
  if ((input.helper ?? process.env[HELPER_ENV]) === "1") return false
  if (input.method === "unknown") return false
  return path.basename(input.execPath ?? process.execPath).toLowerCase() === "codegoblin.exe"
}

export function willUseWindowsUpdateHandoff() {
  return (
    process.platform === "win32" &&
    process.env[HELPER_ENV] !== "1" &&
    path.basename(process.execPath).toLowerCase() === "codegoblin.exe"
  )
}

export async function scheduleWindowsUpdate(input: { method: Method; target: string }) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codegoblin-update-"))
  const helperPath = path.join(directory, "codegoblin-update-helper.exe")
  const statePath = path.join(directory, "state.json")
  const state = {
    parentPID: process.pid,
    installedPath: process.execPath,
    helperPath,
    directory,
    cwd: process.cwd(),
    restartArgs: windowsUpdateRestartArguments(),
    method: input.method,
    target: input.target,
  } satisfies WindowsUpdateState

  try {
    await fs.copyFile(process.execPath, helperPath)
    await fs.writeFile(statePath, JSON.stringify(state), { mode: 0o600 })
    const child = spawn(helperPath, [HELPER_ARGUMENT, statePath], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: {
        ...process.env,
        [HELPER_ENV]: "1",
      },
    })
    await waitForSpawn(child)
    child.unref()
  } catch (error) {
    await fs.rm(directory, { recursive: true, force: true }).catch(() => undefined)
    throw error
  }
}

export function windowsUpdateStatePath(argv = process.argv) {
  const index = argv.indexOf(HELPER_ARGUMENT)
  return index === -1 ? undefined : argv[index + 1]
}

export function windowsUpdateRestartArguments(argv = process.argv.slice(2)) {
  if (argv[0] === "update" || argv[0] === "upgrade") return []
  return argv.filter((arg) => arg !== HELPER_ARGUMENT)
}

export async function runWindowsUpdateHelper(
  statePath: string,
  upgrade: (method: Method, target: string) => Promise<void>,
) {
  const state = parseWindowsUpdateState(JSON.parse(await fs.readFile(statePath, "utf8")))
  await waitForProcessExit(state.parentPID)

  let failure: string | undefined
  try {
    process.env[HELPER_ENV] = "1"
    await upgrade(state.method, state.target)
    const version = await run(state.installedPath, ["--version"], state.cwd)
    if (version.code !== 0) throw new Error("The updated executable failed its version check.")
    if (version.stdout.trim().replace(/^v/, "") !== state.target.replace(/^v/, "")) {
      throw new Error(
        `The update installed '${version.stdout.trim() || "an unknown version"}' instead of '${state.target}'.`,
      )
    }
    await fs.writeFile(
      path.join(state.directory, "result.json"),
      JSON.stringify({ success: true, version: version.stdout.trim() }),
      { mode: 0o600 },
    )
  } catch (error) {
    failure = errorMessage(error) || "The package manager could not complete the update."
    await fs
      .writeFile(path.join(state.directory, "result.json"), JSON.stringify({ success: false, error: failure }), {
        mode: 0o600,
      })
      .catch(() => undefined)
  }

  const executable = (await exists(state.installedPath)) ? state.installedPath : state.helperPath
  const env = { ...process.env }
  delete env[HELPER_ENV]
  delete env[CLEANUP_ENV]
  delete env[ERROR_ENV]
  env[CLEANUP_ENV] = state.directory
  if (failure) env[ERROR_ENV] = failure
  const child = spawn(executable, state.restartArgs, {
    cwd: state.cwd,
    detached: true,
    stdio: "ignore",
    windowsHide: false,
    env,
  })
  await waitForSpawn(child).then(
    () => child.unref(),
    async () => {
      await fs
        .writeFile(
          path.join(state.directory, "result.json"),
          JSON.stringify({ success: false, error: "The update completed, but CodeGoblin could not restart." }),
          { mode: 0o600 },
        )
        .catch(() => undefined)
    },
  )
}

export async function cleanupWindowsUpdate() {
  const directory = process.env[CLEANUP_ENV]
  if (!directory) return
  delete process.env[CLEANUP_ENV]
  if (!path.basename(directory).startsWith("codegoblin-update-")) return
  if (path.dirname(directory) !== os.tmpdir()) return

  for (let attempt = 0; attempt < 20; attempt++) {
    const removed = await fs
      .rm(directory, { recursive: true, force: true })
      .then(() => true)
      .catch(() => false)
    if (removed) return
    await Bun.sleep(100)
  }
}

export function takeWindowsUpdateError() {
  const message = process.env[ERROR_ENV]
  delete process.env[ERROR_ENV]
  return message
}

function parseWindowsUpdateState(value: unknown): WindowsUpdateState {
  if (!value || typeof value !== "object") throw new Error("Invalid Windows update state.")
  const state = value as Record<string, unknown>
  if (!Number.isInteger(state.parentPID) || Number(state.parentPID) <= 0) throw new Error("Invalid parent process.")
  if (typeof state.installedPath !== "string" || path.basename(state.installedPath).toLowerCase() !== "codegoblin.exe")
    throw new Error("Invalid installed executable.")
  if (typeof state.helperPath !== "string" || typeof state.directory !== "string")
    throw new Error("Invalid helper path.")
  if (!path.basename(state.directory).startsWith("codegoblin-update-")) throw new Error("Invalid helper directory.")
  if (path.resolve(path.dirname(state.directory)).toLowerCase() !== path.resolve(os.tmpdir()).toLowerCase())
    throw new Error("Invalid helper directory.")
  if (path.dirname(state.helperPath) !== state.directory) throw new Error("Invalid helper directory.")
  if (
    typeof state.cwd !== "string" ||
    typeof state.target !== "string" ||
    !Array.isArray(state.restartArgs) ||
    !state.restartArgs.every((arg) => typeof arg === "string")
  )
    throw new Error("Invalid update state.")
  if (!isMethod(state.method)) throw new Error("Invalid installation method.")
  return state as WindowsUpdateState
}

function isMethod(value: unknown): value is Method {
  return ["curl", "npm", "yarn", "pnpm", "bun", "brew", "scoop", "choco", "unknown"].includes(String(value))
}

async function waitForProcessExit(pid: number) {
  while (true) {
    try {
      process.kill(pid, 0)
      await Bun.sleep(100)
    } catch {
      return
    }
  }
}

function run(command: string, args: string[], cwd: string) {
  return new Promise<{ code: number; stdout: string }>((resolve, reject) => {
    const child = spawn(command, args, { cwd, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] })
    const chunks: Buffer[] = []
    child.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk))
    child.once("error", reject)
    child.once("exit", (code) => resolve({ code: code ?? 1, stdout: Buffer.concat(chunks).toString("utf8") }))
  })
}

function waitForSpawn(child: ReturnType<typeof spawn>) {
  return new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve)
    child.once("error", reject)
  })
}

async function exists(target: string) {
  return fs.access(target).then(
    () => true,
    () => false,
  )
}
