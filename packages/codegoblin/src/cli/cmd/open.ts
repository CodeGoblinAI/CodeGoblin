import type { CommandModule } from "yargs"
import fs from "fs/promises"
import path from "path"
import { spawn } from "child_process"

type Args = {
  target?: string
  folder?: boolean
  reveal?: boolean
}

const OUTPUT_DIR = "codegoblin-output"

export const OpenCommand = {
  command: "open [target]",
  describe: "open the most recent CodeGoblin output (or a specific path)",
  builder: (yargs) =>
    yargs
      .positional("target", {
        describe: "project-relative path to open; defaults to the most recent output",
        type: "string",
      })
      .option("folder", {
        describe: "open the containing folder instead of the file",
        type: "boolean",
        default: false,
      })
      .option("reveal", {
        describe: "reveal/select the file in the system file manager",
        type: "boolean",
        default: false,
      }),
  handler: async (args) => {
    const root = process.cwd()
    const target = args.target ? path.resolve(root, args.target) : await mostRecentOutput(path.join(root, OUTPUT_DIR))
    if (!target) {
      console.error(`No CodeGoblin output found under ${OUTPUT_DIR}/. Generate an image or audio file first.`)
      process.exitCode = 1
      return
    }
    const rel = path.relative(root, target)
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
      console.error("Output path must stay inside the current project directory.")
      process.exitCode = 1
      return
    }
    const stat = await fs.stat(target).catch(() => undefined)
    if (!stat) {
      console.error("That CodeGoblin output does not exist.")
      process.exitCode = 1
      return
    }
    openPath(target, stat.isDirectory(), args.folder ?? false, args.reveal ?? false)
    console.log(`Opening ${rel}`)
  },
} satisfies CommandModule<object, Args>

async function mostRecentOutput(dir: string): Promise<string | undefined> {
  const entries = await fs.readdir(dir, { withFileTypes: true, recursive: true }).catch(() => undefined)
  if (!entries) return undefined
  let best: { path: string; mtime: number } | undefined
  for (const entry of entries) {
    if (!entry.isFile()) continue
    const dirent = entry as unknown as { parentPath?: string; path?: string }
    const parent = dirent.parentPath ?? dirent.path ?? dir
    const full = path.join(parent, entry.name)
    const stat = await fs.stat(full).catch(() => undefined)
    if (!stat) continue
    if (!best || stat.mtimeMs > best.mtime) best = { path: full, mtime: stat.mtimeMs }
  }
  return best?.path
}

function openPath(target: string, isDirectory: boolean, folder: boolean, reveal: boolean) {
  const openerTarget = folder ? (isDirectory ? target : path.dirname(target)) : target
  if (process.platform === "win32") {
    const args = reveal && !isDirectory ? [`/select,${target}`] : [openerTarget]
    spawn("explorer.exe", args, { detached: true, stdio: "ignore" }).unref()
    return
  }
  if (process.platform === "darwin") {
    const args = reveal && !isDirectory ? ["-R", target] : [openerTarget]
    spawn("open", args, { detached: true, stdio: "ignore" }).unref()
    return
  }
  spawn("xdg-open", [openerTarget], { detached: true, stdio: "ignore" }).unref()
}
