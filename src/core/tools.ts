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
}

const MAX_OUTPUT = 24_000

function resolveInside(root: string, target: string): string {
  const absolute = path.resolve(root, target)
  const relative = path.relative(root, absolute)
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`path escapes the working directory: ${target}`)
  }
  return absolute
}

const clip = (text: string) =>
  text.length > MAX_OUTPUT ? text.slice(0, MAX_OUTPUT) + `\n… truncated at ${MAX_OUTPUT} characters` : text

export const TOOLS: Tool[] = [
  {
    name: "read_file",
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
      await fs.mkdir(path.dirname(target), { recursive: true })
      await fs.writeFile(target, args.content, "utf8")
      const lines = String(args.content).split("\n").length
      return `wrote ${path.relative(root, target)} (${lines} lines)`
    },
  },
  {
    name: "edit_file",
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

export const TOOL_SCHEMA = TOOLS.map((tool) => ({
  type: "function",
  function: { name: tool.name, description: tool.description, parameters: tool.parameters },
}))

export async function runTool(name: string, args: unknown, root: string): Promise<string> {
  const tool = TOOLS.find((candidate) => candidate.name === name)
  if (!tool) return `unknown tool: ${name}`
  try {
    return await tool.run(args, root)
  } catch (error) {
    return `error: ${error instanceof Error ? error.message : String(error)}`
  }
}
