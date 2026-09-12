import fs from "node:fs/promises"
import path from "node:path"

/**
 * Tools the model can call.
 *
 * Every tool is confined to the working directory. Paths are resolved and then
 * checked against the root, so "../.." or an absolute path cannot escape it -
 * a model that has been talked into reading ~/.ssh should simply fail.
 */
export type Tool = {
  name: string
  description: string
  parameters: Record<string, unknown>
  run: (args: any, root: string) => Promise<string>
  /** Changes the file at args.path, so its previous state is worth keeping. */
  writes?: boolean
  /**
   * Safe to run at the same time as the other tools in a turn.
   *
   * Opt-in, and only for tools that read. Anything that writes a file, runs a
   * command or moves the plan stays in order: two writes can contend for the
   * same path, the undo history records a file just before it is overwritten,
   * and a shell command can do any of that without saying so. webfetch is
   * left out too - it asks about each new host, and those questions would
   * arrive on top of each other.
   */
  concurrent?: boolean
}

const MAX_OUTPUT = 24_000

/** Shared with search, so both refuse the same paths. */
export const SKIP_DIRS = new Set(["node_modules", ".git", "dist", ".next", "build", "coverage"])

export function resolveInside(root: string, target: string): string {
  const absolute = path.resolve(root, target)
  const relative = path.relative(root, absolute)
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`path escapes the working directory: ${target}`)
  }
  return absolute
}

/**
 * Paths a tool must never write to. Reading them is fine; a model rewriting
 * .git internals or a lockfile is a bad day, and it is never what was asked.
 */
const PROTECTED_SEGMENTS = new Set([".git", "node_modules"])
const PROTECTED_FILES = new Set(["bun.lock", "bun.lockb", "package-lock.json"])

function assertWritable(relative: string) {
  // Normalise separators without a regex: on Windows path.relative returns
  // backslashes, and an escaped character class is easy to get wrong.
  const BACKSLASH = String.fromCharCode(92)
  const segments = relative.split(BACKSLASH).join("/").split("/").filter(Boolean)
  if (segments.some((segment) => PROTECTED_SEGMENTS.has(segment))) {
    throw new Error(`refusing to write inside a protected directory: ${relative}`)
  }
  const name = segments[segments.length - 1] ?? ""
  if (PROTECTED_FILES.has(name)) {
    throw new Error(`refusing to write to a lockfile: ${relative}`)
  }
}

export const clip = (text: string) =>
  text.length > MAX_OUTPUT ? text.slice(0, MAX_OUTPUT) + `\n… truncated at ${MAX_OUTPUT} characters` : text

export const TOOLS: Tool[] = [
  {
    name: "read_file",
    concurrent: true,
    description: "Read a UTF-8 text file, relative to the working directory.",
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "File path relative to the working directory." } },
      required: ["path"],
    },
    run: async (args, root) => clip(await fs.readFile(resolveInside(root, args.path), "utf8")),
  },
  {
    name: "list_files",
    concurrent: true,
    description: "List entries in a directory, relative to the working directory.",
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "Directory path. Defaults to the working directory." } },
    },
    run: async (args, root) => {
      const dir = resolveInside(root, args.path ?? ".")
      const entries = await fs.readdir(dir, { withFileTypes: true })
      return clip(
        entries
          .filter((entry) => entry.name !== "node_modules" && !entry.name.startsWith(".git"))
          .map((entry) => (entry.isDirectory() ? entry.name + "/" : entry.name))
          .join("\n") || "(empty)",
      )
    },
  },
  {
    name: "write_file",
    writes: true,
    description: "Write a UTF-8 text file, creating parent directories as needed.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
      },
      required: ["path", "content"],
    },
    run: async (args, root) => {
      const target = resolveInside(root, args.path)
      assertWritable(path.relative(root, target))
      await fs.mkdir(path.dirname(target), { recursive: true })
      await fs.writeFile(target, args.content, "utf8")
      const lines = String(args.content).split("\n").length
      return `wrote ${path.relative(root, target)} (${lines} lines)`
    },
  },
  {
    name: "edit_file",
    writes: true,
    description:
      "Replace an exact string in a file. Prefer this over write_file: it changes only what you name, " +
      "and fails loudly if the text is missing or ambiguous instead of silently rewriting the file.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        old_string: { type: "string", description: "Exact text to replace. Must appear exactly once." },
        new_string: { type: "string", description: "Replacement text." },
      },
      required: ["path", "old_string", "new_string"],
    },
    run: async (args, root) => {
      const target = resolveInside(root, args.path)
      assertWritable(path.relative(root, target))
      const before = await fs.readFile(target, "utf8")
      const occurrences = before.split(args.old_string).length - 1

      // Refuse rather than guess. A silent wrong edit is worse than an error.
      if (occurrences === 0) return "error: old_string not found in " + args.path
      if (occurrences > 1) {
        return "error: old_string appears " + occurrences + " times in " + args.path + "; include more context to make it unique"
      }

      const after = before.replace(args.old_string, args.new_string)
      await fs.writeFile(target, after, "utf8")
      return diff(before, after, path.relative(root, target))
    },
  },
]

/**
 * A unified-ish diff, enough to see what changed without a dependency.
 * Walks from both ends to find the changed span, which is all a line-level
 * edit needs.
 */
function diff(before: string, after: string, label: string): string {
  const a = before.split(String.fromCharCode(10))
  const b = after.split(String.fromCharCode(10))

  let head = 0
  while (head < a.length && head < b.length && a[head] === b[head]) head++

  let tail = 0
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++

  const removed = a.slice(head, a.length - tail)
  const added = b.slice(head, b.length - tail)
  const lines = [label + "  +" + added.length + " -" + removed.length, "@@ line " + (head + 1) + " @@"]

  for (const line of removed.slice(0, 20)) lines.push("- " + line)
  for (const line of added.slice(0, 20)) lines.push("+ " + line)
  if (removed.length > 20 || added.length > 20) lines.push("… diff truncated")

  return lines.join(String.fromCharCode(10))
}
/**
 * Shell, search and the rest of the tool surface.
 *
 * Kept together with the file tools so every tool shares one sandbox check
 * and one output cap.
 */
export const EXTRA_TOOLS: Tool[] = [
  {
    name: "shell",
    description:
      "Run a shell command in the working directory and return its combined output and exit code. " +
      "Use this for tests, builds, git, and anything the file tools cannot do.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "The command to run." },
        timeout_ms: { type: "number", description: "Optional timeout, default 30000." },
      },
      required: ["command"],
    },
    run: async (args, root) => runShell(String(args.command ?? ""), root, Number(args.timeout_ms) || 30_000),
  },
  {
    name: "todo_write",
    description:
      "Record or update the plan for the current task. Send the whole list each time, with each " +
      "item marked pending, in_progress or completed. Use it for work of three or more steps so " +
      "the user can see what you intend and what is left. Exactly one item should be in_progress.",
    parameters: {
      type: "object",
      properties: {
        todos: {
          type: "array",
          items: {
            type: "object",
            properties: {
              content: { type: "string" },
              status: { type: "string", enum: ["pending", "in_progress", "completed"] },
            },
            required: ["content", "status"],
          },
        },
      },
      required: ["todos"],
    },
    // The plan is surfaced by the agent loop, which owns per-session state;
    // the tool itself only validates and echoes it back.
    run: async (args) => {
      const { parseTodos, summarise } = await import("./todo")
      const todos = parseTodos(args?.todos)
      return summarise(todos)
    },
  },
  {
    name: "grep",
    concurrent: true,
    description:
      "Search file contents by regular expression. Returns file:line: match. " +
      "Prefer this over reading directories to find where something lives.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Regular expression, case-insensitive." },
        include: { type: "string", description: "Optional glob to limit files, e.g. src/**/*.ts" },
      },
      required: ["query"],
    },
    run: async (args, root) => {
      const { grepFiles } = await import("./search")
      const { matches, truncated } = await grepFiles(root, String(args.query ?? ""), args.include)
      if (!matches.length) return "no matches"
      return clip(matches.join(NEWLINE) + (truncated ? NEWLINE + "... more matches not shown" : ""))
    },
  },
  {
    name: "glob",
    concurrent: true,
    description:
      "Find files by name pattern, newest first. Supports *, ** across directories, ?, " +
      "and {a,b} alternation.",
    parameters: {
      type: "object",
      properties: { pattern: { type: "string", description: "e.g. src/**/*.ts or src/{tui,web}/*.ts" } },
      required: ["pattern"],
    },
    run: async (args, root) => {
      const { globFiles } = await import("./search")
      const pattern = String(args.pattern ?? "*")
      const files = await globFiles(root, pattern)
      // Naming the pattern back is the difference between "these files are not
      // here" and "this pattern found nothing". A bare "no files matched" reads
      // as the first, and a model that believes it stops looking.
      return files.length ? clip(files.join(NEWLINE)) : `no files matched ${pattern}`
    },
  },
  {
    name: "webfetch",
    description:
      "Fetch a public http or https URL and return its readable text. Refuses private and " +
      "loopback addresses, and asks the user before each new host.",
    parameters: {
      type: "object",
      properties: { url: { type: "string", description: "Absolute http or https URL." } },
      required: ["url"],
    },
    run: async (args) => {
      const { fetchUrl } = await import("./webfetch")
      return clip(await fetchUrl(String(args.url ?? "")))
    },
  },
]

const NEWLINE = String.fromCharCode(10)

/**
 * Run a command, bounded.
 *
 * stdout and stderr are merged because a model reading output does not care
 * which stream a line came from, and losing stderr hides the actual error.
 * windowsHide comes from platform/process: a spawn without it opens a console
 * window on Windows, which is invisible on CI and Unix and cost real
 * debugging time in the previous codebase.
 */
async function runShell(command: string, root: string, timeoutMs: number): Promise<string> {
  if (!command.trim()) return "error: empty command"

  const { spawn } = await import("../platform/process")
  const isWindows = process.platform === "win32"
  const argv = isWindows ? ["cmd.exe", "/d", "/s", "/c", command] : ["/bin/sh", "-c", command]

  return new Promise<string>((resolve) => {
    const child = spawn(argv, { cwd: root, stdio: ["ignore", "pipe", "pipe"] })
    let output = ""
    let settled = false

    const finish = (text: string) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { child.kill() } catch {}
      resolve(clip(text))
    }

    const timer = setTimeout(() => finish(output + NEWLINE + `... killed after ${timeoutMs}ms`), timeoutMs)

    child.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString() })
    child.stderr?.on("data", (chunk: Buffer) => { output += chunk.toString() })
    child.once("error", (error: Error) => finish("error: " + error.message))
    child.once("close", (code: number | null) => {
      const trailer = code === 0 ? "" : NEWLINE + `exit code ${code ?? "unknown"}`
      finish((output.trim() || "(no output)") + trailer)
    })
  })
}



export const ALL_TOOLS: Tool[] = [...TOOLS, ...EXTRA_TOOLS]

/**
 * Whether this tool may run alongside the others in the same turn.
 *
 * Unknown names answer false, so a tool that has not said it is safe is
 * treated as though it is not.
 */
export const isConcurrent = (name: string): boolean =>
  ALL_TOOLS.find((tool) => tool.name === name)?.concurrent === true

export const TOOL_SCHEMA = ALL_TOOLS.map((tool) => ({
  type: "function",
  function: { name: tool.name, description: tool.description, parameters: tool.parameters },
}))

export async function runTool(
  name: string,
  args: unknown,
  root: string,
  /** Called with the path a writing tool is about to change, before it changes. */
  onWrite?: (relative: string) => Promise<void>,
): Promise<string> {
  const tool = ALL_TOOLS.find((candidate) => candidate.name === name)
  if (!tool) return `unknown tool: ${name}`
  try {
    if (tool.writes && onWrite) {
      const target = (args as { path?: unknown }).path
      if (typeof target === "string") await onWrite(target)
    }
    return await tool.run(args, root)
  } catch (error) {
    return `error: ${error instanceof Error ? error.message : String(error)}`
  }
}
