#!/usr/bin/env node
/**
 * What `npm install -g @codegoblin-io/codegoblin` puts on the PATH as `codegoblin` and `cg`.
 *
 * CodeGoblin itself is one program per system, published as codegoblin-<system>-<chip>; npm installs the one
 * that fits beside this file. This starts it and gets out of the way: same arguments, same window, same exit
 * code.
 *
 * It also does the one thing the program cannot do for itself. On Windows a running program cannot be
 * replaced, so `codegoblin upgrade` is carried out here, before the program is started.
 */
import childProcess from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

export const PACKAGE = "@codegoblin-io/codegoblin"
const SYSTEMS = { win32: "windows", linux: "linux", darwin: "darwin" }
/** Every program that is published. An Intel Mac is the one common computer without one. */
export const PROGRAMS = ["codegoblin-windows-x64", "codegoblin-windows-arm64", "codegoblin-linux-x64", "codegoblin-linux-arm64", "codegoblin-darwin-arm64"]

/** The package holding the program for this computer, or nothing when there is none for it. */
export function platformPackage(platform = os.platform(), arch = os.arch()) {
  const name = `codegoblin-${SYSTEMS[platform]}-${arch}`
  return PROGRAMS.includes(name) ? name : undefined
}

/** The program, looked for in each node_modules from here upward - npm, pnpm and bun each put it somewhere different. */
export function findProgram(from, name, platform = os.platform()) {
  const file = platform === "win32" ? "codegoblin.exe" : "codegoblin"
  for (let current = from; ; current = path.dirname(current)) {
    const candidate = path.join(current, "node_modules", name, "bin", file)
    if (fs.existsSync(candidate)) return candidate
    if (path.dirname(current) === current) return undefined
  }
}

/** Which package manager installed this, judged from where the file sits. npm when nothing says otherwise. */
export function installedBy(file) {
  const where = file.split(path.sep).join("/").toLowerCase()
  if (where.includes("/.bun/")) return "bun"
  if (where.includes("/pnpm/")) return "pnpm"
  return "npm"
}

export function installCommand(manager, version, platform = os.platform()) {
  const name = platform === "win32" && manager !== "bun" ? manager + ".cmd" : manager
  return [name, [manager === "npm" ? "install" : "add", "-g", `${PACKAGE}@${version}`]]
}

function parse(version) {
  const found = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/.exec(String(version).trim())
  return found ? { main: [Number(found[1]), Number(found[2]), Number(found[3])], pre: found[4] ? found[4].split(".") : [] } : undefined
}

/** Is `candidate` later than `current`? The same order the app uses for its own notice (src/core/update.ts). */
export function newer(candidate, current) {
  const a = parse(candidate), b = parse(current)
  if (!a || !b) return false
  for (let index = 0; index < 3; index++) if (a.main[index] !== b.main[index]) return a.main[index] > b.main[index]
  if (!a.pre.length || !b.pre.length) return !a.pre.length && b.pre.length > 0
  for (let index = 0; index < Math.max(a.pre.length, b.pre.length); index++) {
    const x = a.pre[index], y = b.pre[index]
    if (x === undefined || y === undefined) return y === undefined
    if (x === y) continue
    const nx = /^\d+$/.test(x), ny = /^\d+$/.test(y)
    if (nx && ny) return Number(x) > Number(y)
    if (nx !== ny) return ny
    return x > y
  }
  return false
}

/**
 * What `upgrade [word]` should install: nothing for "already there", otherwise an exact version.
 * No word means the released version (or a later preview for someone already on a preview); `next` asks for
 * the preview; a version number asks for exactly that, older ones included - that is how to go back.
 */
export function target(word, current, tags) {
  if (word && parse(word)) return word.replace(/^v/, "") === current ? undefined : word.replace(/^v/, "")
  if (word && word !== "latest") {
    if (typeof tags[word] !== "string") throw new Error(`There is no "${word}" version. Try: latest, next, or a number such as 0.4.0`)
    return tags[word] === current ? undefined : tags[word]
  }
  const onPreview = Boolean(parse(current)?.pre.length)
  const choices = [tags.latest, ...(onPreview ? [tags.next] : [])].filter((tag) => typeof tag === "string" && newer(tag, current))
  return choices.sort((a, b) => (newer(a, b) ? -1 : 1))[0]
}

async function publishedTags() {
  const registry = process.env.CODEGOBLIN_REGISTRY_URL || "https://registry.npmjs.org"
  const response = await fetch(`${registry}/${PACKAGE.replace("/", "%2f")}`, { headers: { accept: "application/vnd.npm.install-v1+json" }, signal: AbortSignal.timeout(15000) })
  if (!response.ok) throw new Error("the npm registry answered " + response.status)
  return (await response.json())["dist-tags"] ?? {}
}

async function upgrade(args, self) {
  const current = JSON.parse(fs.readFileSync(path.join(path.dirname(self), "..", "package.json"), "utf8")).version
  // --dry-run: say what would be installed and how, and install nothing.
  const dryRun = args.includes("--dry-run")
  const words = args.filter((word) => !word.startsWith("-"))
  let wanted
  try {
    wanted = target(words[0], current, await publishedTags())
    // It goes on a command line next: only ever a plain version number, whatever the registry said.
    if (wanted !== undefined && !parse(wanted)) throw new Error("the registry named a version that is not a version")
  } catch (error) {
    console.error("Could not look for a newer version: " + (error instanceof Error ? error.message : String(error)))
    return 1
  }
  if (!wanted) {
    console.log(`CodeGoblin ${current} is the newest version.`)
    return 0
  }
  const manager = installedBy(self)
  const [command, commandArgs] = installCommand(manager, wanted)
  if (dryRun) {
    console.log(`CodeGoblin ${current} would be updated to ${wanted} with: ${manager} ${commandArgs.join(" ")}`)
    return 0
  }
  console.log(`Updating CodeGoblin ${current} to ${wanted}: ${manager} ${commandArgs.join(" ")}`)
  // npm and pnpm are .cmd files on Windows, which only a shell can start. One plain string for it: every part is
  // fixed text except the version, and that has been checked to be nothing but a version.
  const result = process.platform === "win32"
    ? childProcess.spawnSync([command, ...commandArgs].join(" "), { stdio: "inherit", shell: true })
    : childProcess.spawnSync(command, commandArgs, { stdio: "inherit" })
  if (result.status === 0) {
    console.log(`CodeGoblin ${wanted} is installed. To go back: codegoblin upgrade ${current}`)
    return 0
  }
  console.error(`\nThe update did not finish, and CodeGoblin ${current} is still what is installed.`)
  if (process.platform === "win32") console.error("If CodeGoblin is open in another window, close it and run this again: Windows cannot replace a program that is running.")
  console.error(`To do it by hand: ${manager} ${commandArgs.join(" ")}`)
  return result.status ?? 1
}

function start(program, args) {
  const child = childProcess.spawn(program, args, { stdio: "inherit", env: { ...process.env, CODEGOBLIN_CLI_NAME: process.env.CODEGOBLIN_CLI_NAME || "codegoblin", CODEGOBLIN_LAUNCHER: "npm" } })
  child.on("error", (error) => { console.error("CodeGoblin could not start: " + error.message); process.exit(1) })
  // Ctrl+C goes to everything in the window, so the program already has it and decides what it means; this
  // only has to outlive it. The other two are sent to this process alone and are passed on.
  process.on("SIGINT", () => {})
  for (const signal of ["SIGTERM", "SIGHUP"]) process.on(signal, () => { try { child.kill(signal) } catch {} })
  child.on("exit", (code, signal) => {
    if (signal) { process.removeAllListeners(signal); process.kill(process.pid, signal); return }
    process.exit(code ?? 0)
  })
}

async function main() {
  const self = fs.realpathSync(fileURLToPath(import.meta.url))
  const args = process.argv.slice(2)
  if (args[0] === "upgrade" || args[0] === "update") process.exit(await upgrade(args.slice(1), self))
  const name = platformPackage()
  const program = process.env.CODEGOBLIN_BIN_PATH || (name && findProgram(path.dirname(self), name))
  if (!program) {
    console.error(name
      ? `CodeGoblin's program for this computer (${name}) was not installed with it.\nThis happens when optional packages are skipped. Install again without --no-optional / --omit=optional:\n  npm install -g ${PACKAGE}`
      : `CodeGoblin has no program for ${os.platform()}/${os.arch()} yet. It runs on Windows, Linux and macOS (Apple chips), on x64 and arm64.`)
    process.exit(1)
  }
  start(program, args)
}

const direct = process.argv[1] && fs.existsSync(process.argv[1]) && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))
if (direct) await main()
