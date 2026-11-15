import { spawnSync as nodeSpawnSync } from "node:child_process"
import { realpathSync } from "node:fs"
import fsSync from "node:fs"
import { Global } from "../platform/paths"
import { inRepoCache } from "./repos"
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
  /** signal is the turn's: a tool that can take long ends when the person stops it. */
  run: (args: any, root: string, signal?: AbortSignal, progress?: (text: string) => void) => Promise<string>
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
export const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", ".next", "build", "coverage",
  "output", ".playwright-cli", "_RECOVERED_LOCAL_2026-08-29",
])

/**
 * Where a read-only tool may look: the working directory, or a repository
 * repo_clone put in CG-Next's own clone folder (given as its absolute path).
 * Writing tools never use this - they stay inside the project.
 */
export function resolveReadable(root: string, target: string): string {
  if (path.isAbsolute(target) && (inRepoCache(target) || inSpill(target))) return path.resolve(target)
  return resolveInside(root, target)
}

export function resolveInside(root: string, target: string): string {
  const absolute = path.resolve(root, target)
  if (escapes(root, absolute)) {
    throw new Error(`path escapes the working directory: ${target}`)
  }
  // A link inside the project can point anywhere. Seen with a real model: a
  // junction named "linked" let read_file return a file from outside the
  // project, because the check above only looks at the name. So where the
  // path really lands is checked too.
  const real = realLocation(absolute)
  if (real && escapes(realLocation(root) ?? root, real)) {
    throw new Error(`path escapes the working directory through a link: ${target}`)
  }
  return absolute
}

function escapes(root: string, absolute: string): boolean {
  const relative = path.relative(root, absolute)
  return relative.startsWith("..") || path.isAbsolute(relative)
}

/** The real location of a path, found through its deepest part that exists - a file about to be written does not yet. */
function realLocation(absolute: string): string | undefined {
  let at = absolute
  for (;;) {
    try {
      return path.join(realpathSync.native(at), path.relative(at, absolute))
    } catch {
      const up = path.dirname(at)
      if (up === at) return undefined
      at = up
    }
  }
}

/**
 * Paths a tool must never write to. Reading them is fine; a model rewriting
 * .git internals or a lockfile is a bad day, and it is never what was asked.
 */
const PROTECTED_SEGMENTS = new Set([".git", "node_modules"])
const PROTECTED_FILES = new Set(["bun.lock", "bun.lockb", "package-lock.json"])

export function assertWritable(relative: string) {
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

/** How much of an oversized result the model is shown from each end. */
const HEAD = 16_000
const TAIL = 7_000
/** The most a command's output is kept at all, in memory and in its spill file. */
const MAX_KEPT = 4_000_000

/**
 * Fits text to what a model should be handed: the start and the end, with the middle cut.
 *
 * It used to keep only the start, and the end is where a build or a test run says what went wrong.
 */
export const clip = (text: string) =>
  text.length > MAX_OUTPUT
    ? text.slice(0, HEAD) + `\n\n… ${text.length - HEAD - TAIL} characters cut from the middle …\n\n` + text.slice(-TAIL)
    : text

/** Where oversized command output is kept whole. The OS clears its temp folder; nothing here deletes. */
export const spillDir = () => path.join(Global.Path.tmp, "tool-output")
const inSpill = (target: string) => {
  const relative = path.relative(spillDir(), path.resolve(target))
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative)
}

/**
 * A result fit for the model. When it is too long, the whole of it (as given - redact first) is written to a
 * file the model can read in parts, and the model gets the two ends and where the rest is.
 */
export async function fitResult(text: string, id: string): Promise<string> {
  if (text.length <= MAX_OUTPUT) return text
  const lines = text.split("\n").length
  try {
    await fs.mkdir(spillDir(), { recursive: true })
    const file = path.join(spillDir(), id.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80) + "-" + Date.now().toString(36) + ".txt")
    await fs.writeFile(file, text, { mode: 0o600 })
    return clip(text) + `\n\n(the full output, ${lines} lines, is in ${file} - read_file with offset and limit reads any part of it)`
  } catch {
    return clip(text)
  }
}

/** A window of a file's lines, numbered from 1; says what it left out. */
function lineWindow(text: string, offset: unknown, limit: unknown): string {
  if (offset === undefined && limit === undefined) return clip(text)
  const lines = text.split("\n")
  const from = Math.max(1, Math.floor(Number(offset) || 1))
  const count = Math.max(1, Math.floor(Number(limit) || 400))
  const shown = lines.slice(from - 1, from - 1 + count)
  if (!shown.length) return `(the file has ${lines.length} lines; nothing at line ${from})`
  const to = from + shown.length - 1
  return clip(shown.join("\n")) + (to < lines.length || from > 1 ? `\n(lines ${from}-${to} of ${lines.length})` : "")
}

export const TOOLS: Tool[] = [
  {
    name: "read_file",
    concurrent: true,
    description: "Read a UTF-8 text file, relative to the working directory (or an absolute path inside a repository repo_clone fetched). An image (png, jpg, gif, webp) is shown to you as a picture if you can see images.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path relative to the working directory." },
        offset: { type: "number", description: "Line to start from (1 is the first). For a long file, with limit." },
        limit: { type: "number", description: "How many lines to read from offset (default 400)." },
      },
      required: ["path"],
    },
    run: async (args, root) => lineWindow(await fs.readFile(resolveReadable(root, args.path), "utf8"), args.offset, args.limit),
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
      const dir = resolveReadable(root, args.path ?? ".")
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
      "Use this for tests, builds, git, and anything the file tools cannot do. It waits for the command up to " +
      "timeout_ms; one still running then is not stopped but carries on as a background job, and you get its " +
      "id and its output so far. Something meant to keep running - a dev server, a watcher - is started with " +
      "background: true, which answers at once with a job id.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "The command to run." },
        timeout_ms: { type: "number", description: "How long to wait for it, default 120000, at most 600000. A command still running then is not stopped: it carries on as a background job and you are given its id and its output so far." },
        background: { type: "boolean", description: "Keep it running and answer at once with a job id; job_output reads it, job_stop ends it." },
      },
      required: ["command"],
    },
    run: async (args, root, signal, progress) => {
      const { startJob, runForeground } = await import("./jobs")
      if (args.background === true) return startJob(String(args.command ?? ""), root, { signal })
      return runForeground(String(args.command ?? ""), root, { timeoutMs: shellWait(args.timeout_ms), signal, onOutput: progress })
    },
  },
  {
    name: "job_output",
    description:
      "Read what a background job (started by shell with background: true) has printed since you last read it, " +
      "and whether it is still running. Without an id, lists this project's jobs.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "The job id, such as job1. Leave out to list the jobs." },
        until: { type: "string", description: "Wait until its output contains this text (any case), e.g. the line a server prints when it is ready. Waits 15 s unless wait_ms says otherwise." },
        wait_ms: { type: "number", description: "How long to wait for new output (or for until), at most 120000. Default: no wait." },
      },
    },
    run: async (args, root, signal) => {
      const { readJob } = await import("./jobs")
      return readJob(args ?? {}, root, signal)
    },
  },
  {
    name: "job_stop",
    description: "End a background job and everything it started.",
    parameters: {
      type: "object",
      properties: { id: { type: "string", description: "The job id, such as job1." } },
      required: ["id"],
    },
    run: async (args, root) => {
      const { stopJob } = await import("./jobs")
      return stopJob(String(args?.id ?? ""), root)
    },
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
        path: { type: "string", description: "Optional folder to search instead: a subfolder, or a repository repo_clone fetched." },
      },
      required: ["query"],
    },
    run: async (args, root, signal) => {
      const { grepFiles, walkNote } = await import("./search")
      const base = typeof args.path === "string" && args.path ? resolveReadable(root, args.path) : root
      const { matches, truncated, skipped, secret, total, end } = await grepFiles(base, String(args.query ?? ""), args.include, signal)
      const notSearched =
        (skipped.length ? NEWLINE + "not searched, too large: " + skipped.slice(0, 10).join(", ") : "") +
        (secret.length ? NEWLINE + `not searched, ${secret.length === 1 ? "it holds" : "they hold"} secrets: ${secret.slice(0, 10).join(", ")}${secret.length > 10 ? ", ..." : ""} (read_file asks the user first)` : "")
      const partway = walkNote(end) ? NEWLINE + walkNote(end) : ""
      if (!matches.length) return "no matches" + notSearched + partway
      const more = truncated ? NEWLINE + `... ${total} matching lines in all; the first ${matches.length} are shown` : ""
      return clip(matches.join(NEWLINE) + more + notSearched + partway)
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
      properties: {
        pattern: { type: "string", description: "e.g. src/**/*.ts or src/{tui,web}/*.ts" },
        path: { type: "string", description: "Optional folder to search instead: a subfolder, or a repository repo_clone fetched." },
      },
      required: ["pattern"],
    },
    run: async (args, root, signal) => {
      const { globFiles, walkNote } = await import("./search")
      const pattern = String(args.pattern ?? "*")
      const end = { stopped: false, capped: false }
      const base = typeof args.path === "string" && args.path ? resolveReadable(root, args.path) : root
      const files = await globFiles(base, pattern, 200, signal, end)
      const partway = walkNote(end) ? NEWLINE + walkNote(end) : ""
      // Naming the pattern back is the difference between "these files are not
      // here" and "this pattern found nothing". A bare "no files matched" reads
      // as the first, and a model that believes it stops looking.
      return (files.length ? clip(files.join(NEWLINE)) : `no files matched ${pattern}`) + partway
    },
  },
  {
    name: "skill",
    description:
      "Load one of the skills listed in the system prompt: its instructions, and the files that come " +
      "with it. Pass file to read one of those files, by the path the skill lists.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "The skill's name, as listed." },
        file: { type: "string", description: "Optional. A file inside the skill's folder, relative to it." },
      },
      required: ["name"],
    },
    concurrent: true,
    run: async (args, root) => {
      const { runSkillTool } = await import("./skills")
      return runSkillTool(String(args.name ?? ""), typeof args.file === "string" ? args.file : undefined, root)
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
  {
    name: "repo_clone",
    description:
      "Clone (shallow) a public repository into CG-Next's own clone folder, to read its source - never into the project. " +
      "Takes owner/repo, host/owner/repo or an https URL; returns the folder, which read_file, list_files, grep and glob " +
      "(with path) can then read. Asks the user first. For research, not for changing anything.",
    parameters: {
      type: "object",
      properties: {
        repository: { type: "string", description: "owner/repo (GitHub), host/owner/repo, or an https URL." },
        refresh: { type: "boolean", description: "Fetch the latest when it is already cloned." },
        branch: { type: "string", description: "A branch or tag to clone instead of the default." },
      },
      required: ["repository"],
    },
    run: async (args, _root, signal) => {
      const { cloneRepo } = await import("./repos")
      return cloneRepo(String(args.repository ?? ""), { refresh: args.refresh === true, branch: typeof args.branch === "string" ? args.branch : undefined, signal })
    },
  },
  {
    name: "repo_overview",
    concurrent: true,
    description:
      "Summarise a repository or folder: languages, package manager, likely entry points, docs and a two-level layout. " +
      "Takes a cloned repository (owner/repo, as given to repo_clone) or a folder in the project.",
    parameters: {
      type: "object",
      properties: { target: { type: "string", description: "owner/repo of a cloned repository, or a folder path (default: the project)." } },
    },
    run: async (args, root) => {
      const { parseRepo, repoOverview } = await import("./repos")
      const target = typeof args.target === "string" && args.target.trim() ? args.target.trim() : "."
      let folder: string
      try {
        folder = resolveReadable(root, target)
        if (!fsSync.existsSync(folder)) throw new Error("missing")
      } catch {
        folder = parseRepo(target).folder
        if (!fsSync.existsSync(folder)) return `error: ${target} is neither a folder here nor a cloned repository - repo_clone it first`
      }
      return clip(repoOverview(folder))
    },
  },
  {
    // Offered only to models trained on it (agent.ts usesPatch); run by runTool,
    // which records every file it touches for /undo before writing any.
    name: "apply_patch",
    description:
      "Edit files with a patch: *** Begin Patch, then for each file *** Add File: <path> (every line +), " +
      "*** Delete File: <path>, or *** Update File: <path> (optionally *** Move to: <path>) followed by " +
      "@@ hunks of context lines (space), removed lines (-) and added lines (+), then *** End Patch. " +
      "Paths are relative to the working directory. The whole patch applies or none of it does.",
    parameters: {
      type: "object",
      properties: { patch: { type: "string", description: "The whole patch, from *** Begin Patch to *** End Patch." } },
      required: ["patch"],
    },
    run: async () => "error: apply_patch runs through runTool",
  },
  {
    name: "websearch",
    description:
      "Search the web and return the most relevant pages' text, for what is newer than you know or " +
      "not in the project. Asks the user first, since the query leaves the machine. Use the year " +
      "from the environment when searching for anything recent.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "What to search for, in a few key words." },
        numResults: { type: "number", description: "How many results, 1-10 (default 6)." },
      },
      required: ["query"],
    },
    run: async (args, _root, signal) => {
      const { searchWeb } = await import("./websearch")
      return clip(await searchWeb(String(args.query ?? ""), { numResults: typeof args.numResults === "number" ? args.numResults : undefined, signal }))
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
/**
 * The environment a command the model runs gets: everything but variables
 * whose names say they hold a key, a secret, a token or a password - Codex's
 * default. Seen with a real model: asked for "my DeepSeek key", it ran a
 * command that printed DEEPSEEK_API_KEY in full into the conversation, and a
 * file with instructions planted in it could ask for the same thing.
 */
const SECRET_NAME = /KEY|SECRET|TOKEN|PASSWORD/i

export function shellEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !SECRET_NAME.test(name)))
}

/** How long the shell tool waits for a command when the model does not say, and the most it may ask for. */
export const SHELL_WAIT_MS = 120_000
export const SHELL_WAIT_MAX_MS = 600_000
/** The wait for one command: the default when none or nonsense is given, never more than the cap. */
export function shellWait(asked: unknown): number {
  const value = Number(asked)
  return Number.isFinite(value) && value > 0 ? Math.min(value, SHELL_WAIT_MAX_MS) : SHELL_WAIT_MS
}

/**
 * Ends a command and everything it started. Killing only the shell left the
 * program it ran behind: a real model's `ping -t` kept pinging after its
 * timeout, with nothing left that could stop it.
 */
export function killTree(child: { pid?: number; kill: () => boolean }) {
  try {
    if (!child.pid) child.kill()
    else if (process.platform === "win32") {
      nodeSpawnSync("taskkill", ["/T", "/F", "/PID", String(child.pid)], { stdio: "ignore", windowsHide: true })
    } else process.kill(-child.pid, "SIGKILL")
  } catch {
    try { child.kill() } catch {}
  }
}

/** Every occurrence of a known secret, replaced by a marker that says what was there. */
export function redactSecrets(text: string, secrets: string[]): string {
  let out = text
  for (const secret of secrets) if (out.includes(secret)) out = out.split(secret).join("[stored secret hidden by CG-Next]")
  return out
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
  signal?: AbortSignal,
  /** Given what a running tool prints as it prints it (the shell's output), for a person to watch. */
  progress?: (text: string) => void,
): Promise<string> {
  const tool = ALL_TOOLS.find((candidate) => candidate.name === name)
  if (!tool) return `unknown tool: ${name}`
  if (name === "apply_patch") {
    try {
      const { parsePatch, planPatch, writePatch } = await import("./patch")
      const plan = planPatch(root, parsePatch(String((args as { patch?: unknown })?.patch ?? "")))
      let result = await writePatch(root, plan, onWrite)
      const { formatAfterWrite } = await import("./formatter")
      for (const write of plan.writes) {
        if (write.content === null) continue
        const note = await formatAfterWrite(root, resolveInside(root, write.path), { signal }).catch(() => "")
        if (note) result += NEWLINE + write.path + " " + note
      }
      return result
    } catch (error) {
      return `error: ${error instanceof Error ? error.message : String(error)} (nothing was changed)`
    }
  }
  try {
    const target = tool.writes ? (args as { path?: unknown }).path : undefined
    if (tool.writes && onWrite && typeof target === "string") await onWrite(target)
    const result = await tool.run(args, root, signal, progress)
    // A write that landed is formatted in the project's style, when the config says to.
    if (tool.writes && typeof target === "string" && !result.startsWith("error")) {
      const { formatAfterWrite } = await import("./formatter")
      const note = await formatAfterWrite(root, resolveInside(root, target), { signal }).catch(() => "")
      if (note) return result + NEWLINE + note
    }
    return result
  } catch (error) {
    return `error: ${error instanceof Error ? error.message : String(error)}`
  }
}
