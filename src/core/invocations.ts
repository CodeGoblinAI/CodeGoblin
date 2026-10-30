import fs from "node:fs"
import path from "node:path"
import { Global } from "../platform/paths"
import { runCommand } from "./commands"
import { parseFrontmatter } from "./frontmatter"
import { invokedSkillText, listSkills } from "./skills"
import { PROMPT_COMMANDS } from "./prompt-commands"

/**
 * Slash commands that are really messages: custom commands and skills.
 *
 * A custom command is a Markdown file whose body is a prompt template, in the
 * fork's format: `{command,commands}/**\/*.md` under the config directory or a
 * project's `.codegoblin`, plus Claude Code's `commands` folders. Its name is
 * its path under that folder without `.md`, so `commands/git/commit.md` is
 * `/git/commit`.
 *
 * Typing `/name arguments` sends the expanded template - or, for a skill, the
 * skill's instructions and the arguments - as the message, while the line
 * typed is what the transcript shows. A built-in command of the same name
 * always wins, so nothing on disk can take over /help or /disconnect.
 *
 * Not supported: the fork's `!` + backtick shell substitution (it would run a
 * command before anyone is asked), and the `agent`, `model` and `subtask` keys.
 */
export type CustomCommand = {
  name: string
  description?: string
  argumentHint?: string
  template: string
  location: string
  /** "built-in" is one of the prompts CG-Next ships (prompt-commands.ts). */
  scope: "project" | "global" | "built-in"
}

export type Invocation = { kind: "skill" | "command"; name: string; args: string; content: string }

type Root = { dir: string; folders: string[]; scope: "project" | "global" }

function commandRoots(cwd: string): Root[] {
  const home = Global.Path.home
  const global: Root[] = [
    { dir: Global.Path.config, folders: ["command", "commands"], scope: "global" },
    { dir: path.join(home, ".claude"), folders: ["commands"], scope: "global" },
  ]
  const same = new Set(global.map((root) => path.resolve(root.dir).toLowerCase()))
  const project: Root[] = [
    { dir: path.join(cwd, ".codegoblin"), folders: ["command", "commands"], scope: "project" },
    { dir: path.join(cwd, ".claude"), folders: ["commands"], scope: "project" },
  ]
  return [...project.filter((root) => !same.has(path.resolve(root.dir).toLowerCase())), ...global]
}

function markdownFiles(dir: string, depth = 0, out: string[] = []): string[] {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name)
    let folder = entry.isDirectory()
    if (!folder && entry.isSymbolicLink()) {
      try {
        folder = fs.statSync(full).isDirectory()
      } catch {
        folder = false
      }
    }
    if (folder) {
      if (depth < 4 && entry.name !== "node_modules" && entry.name !== ".git") markdownFiles(full, depth + 1, out)
    } else if (entry.name.toLowerCase().endsWith(".md")) {
      out.push(full)
    }
  }
  return out
}

export function customCommands(cwd: string = process.cwd()): CustomCommand[] {
  const found = new Map<string, CustomCommand>()
  for (const root of commandRoots(cwd)) {
    for (const folder of root.folders) {
      const base = path.join(root.dir, folder)
      for (const file of markdownFiles(base)) {
        const name = path.relative(base, file).split(path.sep).join("/").replace(/\.md$/i, "")
        if (!name || found.has(name)) continue
        let text: string
        try {
          text = fs.readFileSync(file, "utf8")
        } catch {
          continue
        }
        const { data, body } = parseFrontmatter(text)
        const template = body.trim()
        if (!template) continue
        const text_ = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : undefined)
        found.set(name, {
          name,
          ...(text_(data.description) ? { description: text_(data.description) } : {}),
          ...(text_(data["argument-hint"]) ? { argumentHint: text_(data["argument-hint"]) } : {}),
          template,
          location: file,
          scope: root.scope,
        })
      }
    }
  }
  // The shipped prompts fill in last, so a file of the same name replaces one.
  for (const prompt of PROMPT_COMMANDS) {
    if (found.has(prompt.name)) continue
    found.set(prompt.name, { ...prompt, location: "built-in", scope: "built-in" })
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * A template with its arguments put in, the way the fork does it.
 *
 * `$1`, `$2`... take one argument each, quotes kept together, and the highest
 * one takes everything left over. `$ARGUMENTS` is the whole line. A template
 * that asks for neither gets the arguments added at the end, so nothing typed
 * is ever dropped.
 */
export function expandTemplate(template: string, args: string): string {
  const parts = (args.match(/"[^"]*"|'[^']*'|[^\s"']+/g) ?? []).map((part) => part.replace(/^["']|["']$/g, ""))
  const numbered = template.match(/\$\d+/g) ?? []
  const last = numbered.reduce((max, each) => Math.max(max, Number(each.slice(1))), 0)
  let out = template.replace(/\$(\d+)/g, (_, digits: string) => {
    const position = Number(digits)
    if (position < 1 || position > parts.length) return ""
    return position === last ? parts.slice(position - 1).join(" ") : parts[position - 1]!
  })
  const usesAll = template.includes("$ARGUMENTS")
  out = out.split("$ARGUMENTS").join(args)
  if (!numbered.length && !usesAll && args.trim()) out += "\n\n" + args.trim()
  return out.trim()
}

/** Whether a built-in command answers to this name - aliases included, so /new and /exit are covered too. */
function isBuiltIn(name: string): boolean {
  const result = runCommand("/" + name)
  return !(result.kind === "message" && result.text.startsWith("unknown command"))
}

/** The message a typed line becomes, when it names a custom command or a skill rather than a built-in. */
export function resolveInvocation(text: string, cwd: string = process.cwd()): Invocation | undefined {
  const line = text.trim()
  if (!line.startsWith("/")) return undefined
  const space = line.search(/\s/)
  const name = (space === -1 ? line : line.slice(0, space)).slice(1)
  const args = space === -1 ? "" : line.slice(space).trim()
  if (!name || isBuiltIn(name)) return undefined

  const command = customCommands(cwd).find((each) => each.name === name)
  if (command) return { kind: "command", name, args, content: expandTemplate(command.template, args) }

  const skill = listSkills(cwd).find((each) => each.name === name && each.userInvocable)
  if (skill) return { kind: "skill", name, args, content: invokedSkillText(skill, args) }
  return undefined
}

const firstLine = (text: string | undefined, max = 110) => {
  const flat = (text ?? "").replace(/\s+/g, " ").trim()
  return flat.length > max ? flat.slice(0, max - 1).trimEnd() + "…" : flat
}

/** What the slash-command pickers list for custom commands and skills, built-ins left out. */
export function invocationItems(cwd: string = process.cwd()): { value: string; hint: string }[] {
  const items: { value: string; hint: string }[] = []
  const taken = new Set<string>()
  for (const command of customCommands(cwd)) {
    if (isBuiltIn(command.name)) continue
    taken.add(command.name)
    items.push({
      value: "/" + command.name,
      hint: "command" + (command.argumentHint ? " " + command.argumentHint : "") + " - " + firstLine(command.description ?? command.template),
    })
  }
  for (const skill of listSkills(cwd)) {
    if (!skill.userInvocable || taken.has(skill.name) || /\s/.test(skill.name) || isBuiltIn(skill.name)) continue
    items.push({
      value: "/" + skill.name,
      hint: "skill" + (skill.argumentHint ? " " + skill.argumentHint : "") + " - " + firstLine(skill.description),
    })
  }
  return items
}
