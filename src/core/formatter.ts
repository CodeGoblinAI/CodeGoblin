import fs from "node:fs"
import path from "node:path"
import { spawn } from "node:child_process"
import { loadConfig, type FormatterConfig } from "./config"

/**
 * Formatting a file after the model writes it.
 *
 * The fork's `"formatter": true`: a model's edit lands in the project's own
 * style, so the diff shows what changed rather than whitespace. Off unless
 * codegoblin.jsonc turns it on, as in the fork - running a program on every
 * write is not something to start doing to someone's tree unasked.
 *
 * Only a formatter the project already uses is run: prettier or biome from
 * the project's own node_modules (never a download), ruff where the project
 * configures it, and the language's own tool (gofmt, rustfmt, ...) from PATH.
 * The model is told when a file was reformatted, because its next edit has to
 * match the formatted text, not what it wrote.
 */
export type Formatter = { name: string; extensions: string[]; command: string[] }

const TIMEOUT_MS = 15_000
const WEB = [".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts", ".json", ".jsonc", ".css", ".scss", ".less", ".html", ".vue", ".svelte", ".md", ".mdx", ".yaml", ".yml", ".graphql"]

/** A program on PATH, as an absolute path - Windows extensions included. */
export function onPath(program: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const dirs = (env.PATH ?? env.Path ?? "").split(path.delimiter).filter(Boolean)
  const extensions = process.platform === "win32" ? (env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").map((e) => e.toLowerCase()) : [""]
  for (const dir of dirs) {
    for (const extension of extensions) {
      const candidate = path.join(dir, program + extension)
      try { if (fs.statSync(candidate).isFile()) return candidate } catch {}
    }
  }
  return undefined
}

/** package.json files from the root's folder upward, nearest first, stopping at the root's drive or home. */
function packageJsons(root: string): Record<string, unknown>[] {
  const found: Record<string, unknown>[] = []
  let dir = path.resolve(root)
  for (let depth = 0; depth < 6; depth++) {
    try { found.push(JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"))) } catch {}
    const up = path.dirname(dir)
    if (up === dir) break
    dir = up
  }
  return found
}

const depends = (root: string, name: string) =>
  packageJsons(root).some((json) => {
    const deps = { ...(json.dependencies as object), ...(json.devDependencies as object) } as Record<string, unknown>
    return Boolean(deps[name])
  })

/** The project's own copy of a node tool, never one fetched for the occasion. */
function localBin(root: string, name: string): string | undefined {
  let dir = path.resolve(root)
  for (let depth = 0; depth < 6; depth++) {
    for (const file of process.platform === "win32" ? [name + ".cmd", name + ".exe", name] : [name]) {
      const candidate = path.join(dir, "node_modules", ".bin", file)
      if (fs.existsSync(candidate)) return candidate
    }
    const up = path.dirname(dir)
    if (up === dir) break
    dir = up
  }
  return undefined
}

const exists = (root: string, ...files: string[]) => files.some((file) => fs.existsSync(path.join(root, file)))
const mentions = (root: string, file: string, text: string) => {
  try { return fs.readFileSync(path.join(root, file), "utf8").includes(text) } catch { return false }
}

/** The built-in formatters, each only where the project already uses it. */
export function builtIns(root: string, env: NodeJS.ProcessEnv = process.env): Formatter[] {
  const list: Formatter[] = []
  if (exists(root, "biome.json", "biome.jsonc") && depends(root, "@biomejs/biome")) {
    const bin = localBin(root, "biome")
    if (bin) list.push({ name: "biome", extensions: WEB, command: [bin, "format", "--write", "$FILE"] })
  }
  if (depends(root, "prettier")) {
    const bin = localBin(root, "prettier")
    if (bin) list.push({ name: "prettier", extensions: WEB, command: [bin, "--write", "$FILE"] })
  }
  const ruff = onPath("ruff", env)
  if (ruff && (exists(root, "ruff.toml", ".ruff.toml") || mentions(root, "pyproject.toml", "[tool.ruff") || mentions(root, "requirements.txt", "ruff"))) {
    list.push({ name: "ruff", extensions: [".py", ".pyi"], command: [ruff, "format", "$FILE"] })
  }
  const own: [string, string[], (bin: string) => string[]][] = [
    ["gofmt", [".go"], (bin) => [bin, "-w", "$FILE"]],
    ["rustfmt", [".rs"], (bin) => [bin, "$FILE"]],
    ["zig", [".zig", ".zon"], (bin) => [bin, "fmt", "$FILE"]],
    ["dart", [".dart"], (bin) => [bin, "format", "$FILE"]],
    ["terraform", [".tf", ".tfvars"], (bin) => [bin, "fmt", "$FILE"]],
  ]
  for (const [program, extensions, command] of own) {
    const bin = onPath(program, env)
    if (bin) list.push({ name: program, extensions, command: command(bin) })
  }
  return list
}

/** The formatters codegoblin.jsonc turns on: built-ins with their overrides, plus any it defines. */
export function formattersFor(root: string, config: FormatterConfig, env: NodeJS.ProcessEnv = process.env): Formatter[] {
  if (!config.enabled) return []
  const list = builtIns(root, env)
    .filter((formatter) => !config.entries[formatter.name]?.disabled)
    .map((formatter) => {
      const entry = config.entries[formatter.name]
      return entry ? { ...formatter, command: entry.command ?? formatter.command, extensions: entry.extensions ?? formatter.extensions } : formatter
    })
  for (const [name, entry] of Object.entries(config.entries)) {
    if (entry.disabled || list.some((formatter) => formatter.name === name)) continue
    if (entry.command?.length && entry.extensions?.length) list.push({ name, command: entry.command, extensions: entry.extensions })
  }
  return list
}

/** One line for /status: which formatters run here, or how to turn them on. */
export function formatterStatus(root: string): string {
  const config = loadConfig().formatter
  if (!config.enabled) return 'off - "formatter": true in codegoblin.jsonc turns it on'
  const names = formattersFor(root, config).map((formatter) => formatter.name)
  return names.length ? names.join(", ") : "on, but none this project uses was found"
}

export function formatterFor(file: string, formatters: Formatter[]): Formatter | undefined {
  const extension = path.extname(file).toLowerCase()
  return formatters.find((formatter) => formatter.extensions.includes(extension))
}

/**
 * Formats one file the model just wrote, and says so in a line for the tool
 * result - or nothing, when no formatter applies or the file did not change.
 */
export async function formatAfterWrite(root: string, absolute: string, options: { config?: FormatterConfig; env?: NodeJS.ProcessEnv; signal?: AbortSignal } = {}): Promise<string> {
  const config = options.config ?? loadConfig().formatter
  if (!config.enabled) return ""
  const formatter = formatterFor(absolute, formattersFor(root, config, options.env))
  if (!formatter) return ""
  let before: string
  try { before = fs.readFileSync(absolute, "utf8") } catch { return "" }
  const [program, ...args] = formatter.command.map((part) => part.split("$FILE").join(absolute))
  // A project's prettier or biome is a .cmd on Windows, which only cmd.exe can run. It used to be handed the
  // file's path through Node's shell option, unquoted: a path with a space in it ("C:\Users\John Smith\...")
  // was two arguments, and a file named `a&mkdir x&.js` ran `mkdir x` - a model whose edits are approved
  // without asking could run a command that way. It goes to cmd.exe as the shell tool's commands do, every
  // part in quotes, where & | < > are text. % and ! are expanded even in quotes, so a name with them is left.
  const script = process.platform === "win32" && /\.(cmd|bat)$/i.test(program!)
  if (script && [program!, ...args].some((part) => /["%!]/.test(part))) return `(${formatter.name} was not run: the file's path has % or ! in it, which cmd.exe would read as a variable; the file is as written)`
  const [exe, argv, extra]: [string, string[], { windowsVerbatimArguments?: boolean }] = script
    ? ["cmd.exe", ["/d", "/s", "/c", '"' + [program!, ...args].map((part) => '"' + part + '"').join(" ") + '"'], { windowsVerbatimArguments: true }]
    : [program!, args, {}]
  const outcome = await new Promise<{ code: number | null; output: string }>((resolve) => {
    let output = ""
    let child
    try {
      child = spawn(exe, argv, { cwd: root, windowsHide: true, signal: options.signal, ...extra })
    } catch (error) {
      resolve({ code: -1, output: error instanceof Error ? error.message : String(error) })
      return
    }
    const timer = setTimeout(() => child.kill(), TIMEOUT_MS)
    child.stdout?.on("data", (chunk) => { output = (output + chunk).slice(-400) })
    child.stderr?.on("data", (chunk) => { output = (output + chunk).slice(-400) })
    child.on("error", (error) => { clearTimeout(timer); resolve({ code: -1, output: error.message }) })
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, output }) })
  })
  if (outcome.code !== 0) return `(${formatter.name} could not format it: ${outcome.output.trim().split(/\r?\n/).at(-1)?.slice(0, 160) || "exit " + outcome.code}; the file is as written)`
  let after: string
  try { after = fs.readFileSync(absolute, "utf8") } catch { return "" }
  return after === before ? "" : `(formatted with ${formatter.name} - read it again before editing it, the text may differ from what was written)`
}
