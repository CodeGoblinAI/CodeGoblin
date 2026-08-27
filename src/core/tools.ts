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
]

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
