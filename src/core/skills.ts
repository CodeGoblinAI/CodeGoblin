import fs from "node:fs"
import path from "node:path"
import { Global } from "../platform/paths"
import { parseFrontmatter } from "./frontmatter"
import { clip } from "./tools"

/**
 * Skills: a folder with a SKILL.md, instructions for one kind of task.
 *
 * The model sees a short index of them in the system prompt and loads one with
 * the skill tool when a task matches; a person starts one by typing its name
 * as a slash command. Found in the same places the fork and Claude Code look,
 * so the one skill store on this machine serves all of them:
 *
 *   <project>/.codegoblin/skills, <project>/.claude/skills, <project>/.agents/skills
 *   <config>/skills, ~/.claude/skills, ~/.agents/skills
 *
 * A name found twice keeps the first, so a project's own skill wins over a
 * global one of the same name. Read fresh each time, so a skill written during
 * a session is there for the next message.
 */
export type Skill = {
  name: string
  description?: string
  argumentHint?: string
  /** The SKILL.md itself. */
  location: string
  dir: string
  scope: "project" | "global"
  /** False when the skill says `disable-model-invocation: true` - only a person can start it. */
  modelInvocable: boolean
  /** False when the skill says `user-invocable: false` - it is not a slash command. */
  userInvocable: boolean
  body: string
}

const MAX_DEPTH = 3
const SKIP = new Set(["node_modules", ".git"])
/** What the index shows of a description. Some run to a paragraph, and every one is paid for on every request. */
const INDEX_DESCRIPTION = 300
const FILE_LIST_LIMIT = 20

type Root = { dir: string; scope: "project" | "global" }

export function skillRoots(cwd: string): Root[] {
  const home = Global.Path.home
  const global: Root[] = [
    { dir: path.join(Global.Path.config, "skills"), scope: "global" },
    { dir: path.join(home, ".claude", "skills"), scope: "global" },
    { dir: path.join(home, ".agents", "skills"), scope: "global" },
  ]
  const same = new Set(global.map((root) => path.resolve(root.dir).toLowerCase()))
  const project: Root[] = [
    { dir: path.join(cwd, ".codegoblin", "skills"), scope: "project" },
    { dir: path.join(cwd, ".claude", "skills"), scope: "project" },
    { dir: path.join(cwd, ".agents", "skills"), scope: "project" },
  ]
  // Working in the home directory makes ~/.claude/skills look like a project's.
  return [...project.filter((root) => !same.has(path.resolve(root.dir).toLowerCase())), ...global]
}

/** A folder reached through a link counts: skill folders are often links into one shared store. */
function isFolder(entry: fs.Dirent, full: string): boolean {
  if (entry.isDirectory()) return true
  if (!entry.isSymbolicLink()) return false
  try {
    return fs.statSync(full).isDirectory()
  } catch {
    return false
  }
}

function walk(dir: string, visit: (full: string, entry: fs.Dirent) => void, depth = 0) {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name)
    if (isFolder(entry, full)) {
      if (depth < MAX_DEPTH && !SKIP.has(entry.name)) walk(full, visit, depth + 1)
      continue
    }
    visit(full, entry)
  }
}

function readSkill(file: string, scope: Skill["scope"]): Skill | undefined {
  let text: string
  try {
    text = fs.readFileSync(file, "utf8")
  } catch {
    return undefined
  }
  const { data, body } = parseFrontmatter(text)
  const dir = path.dirname(file)
  const text_ = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : undefined)
  // skillName is below: a broken or unusable name falls back to the folder.
  return {
    // A skill without a name is named after its folder, the way Claude Code reads it.
    name: skillName(text_(data.name), dir),
    ...(text_(data.description) ? { description: text_(data.description) } : {}),
    ...(text_(data["argument-hint"]) ? { argumentHint: text_(data["argument-hint"]) } : {}),
    location: file,
    dir,
    scope,
    modelInvocable: data["disable-model-invocation"] !== true,
    userInvocable: data["user-invocable"] !== false,
    body: body.trim(),
  }
}

/**
 * The name a skill is called by. One that could not be typed as a command -
 * broken frontmatter, spaces, brackets - is replaced by the folder's name.
 * A SKILL.md whose header did not parse was listed as "/[unclosed".
 */
export function skillName(given: string | undefined, dir: string): string {
  return given && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(given) ? given : path.basename(dir)
}

export function listSkills(cwd: string = process.cwd()): Skill[] {
  const found = new Map<string, Skill>()
  for (const root of skillRoots(cwd)) {
    walk(root.dir, (full, entry) => {
      if (entry.name !== "SKILL.md") return
      const skill = readSkill(full, root.scope)
      if (skill && !found.has(skill.name)) found.set(skill.name, skill)
    })
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name))
}

const flatten = (text: string, max: number) => {
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length > max ? flat.slice(0, max - 1).trimEnd() + "…" : flat
}

/** The part of the system prompt that tells the model which skills exist. Nothing when none can be offered. */
export function skillIndex(skills: Skill[]): string | undefined {
  const offered = skills.filter((skill) => skill.modelInvocable && skill.description)
  if (!offered.length) return undefined
  return [
    "Skills are instructions for particular kinds of task. When a task matches one below, load it",
    "with the skill tool before starting, rather than guessing what it says.",
    "",
    ...offered.map((skill) => `- ${skill.name}: ${flatten(skill.description!, INDEX_DESCRIPTION)}`),
  ].join("\n")
}

/** The files that come with a skill, relative to its folder. */
export function skillFiles(skill: Skill): string[] {
  const files: string[] = []
  walk(skill.dir, (full) => {
    const relative = path.relative(skill.dir, full).split(path.sep).join("/")
    if (relative !== "SKILL.md") files.push(relative)
  })
  return files
}

/** A skill as the model reads it: its instructions, where it lives, and what else is in its folder. */
export function skillContent(skill: Skill): string {
  const files = skillFiles(skill)
  const shown = files.slice(0, FILE_LIST_LIMIT)
  return [
    `<skill_content name="${skill.name}">`,
    `# Skill: ${skill.name}`,
    "",
    skill.body,
    "",
    `Base directory for this skill: ${skill.dir}`,
    files.length
      ? `Files that come with it${files.length > shown.length ? ` (first ${shown.length} of ${files.length})` : ""} - read one with the skill tool, passing its path as file:`
      : "No other files come with it.",
    ...shown.map((file) => "- " + file),
    "</skill_content>",
  ].join("\n")
}

/** What the model is sent when a person starts a skill with its slash command. */
export function invokedSkillText(skill: Skill, args: string): string {
  return [
    `Use the "${skill.name}" skill for this. Its instructions follow.`,
    "",
    skillContent(skill),
    ...(args ? ["", "Request: " + args] : []),
  ].join("\n")
}

/**
 * The skill tool.
 *
 * With only a name, the skill's instructions. With a file, that file - and
 * only from inside the skill's folder, links resolved first, so a skill cannot
 * be used to read anything else. read_file stays confined to the working
 * directory, which is why the files a skill ships with come through here.
 */
export function runSkillTool(name: string, file: string | undefined, root: string): string {
  const skills = listSkills(root)
  const skill = skills.find((each) => each.name === name)
  if (!skill) {
    const available = skills.filter((each) => each.modelInvocable).map((each) => each.name)
    return `error: no skill named "${name}". Available: ${available.join(", ") || "none"}`
  }
  if (!skill.modelInvocable) {
    return `error: the ${name} skill is marked disable-model-invocation - only the user can start it`
  }
  if (!file) return clip(skillContent(skill))

  // Checked on the path as written first, so a way out of the folder is refused
  // the same way whether or not anything exists there - and again with links
  // resolved, so a link inside the folder cannot point out of it.
  const outside = (from: string, to: string) => {
    const relative = path.relative(from, to)
    return relative.startsWith("..") || path.isAbsolute(relative)
  }
  if (outside(path.resolve(skill.dir), path.resolve(skill.dir, file))) {
    return `error: ${file} is outside the ${name} skill's folder`
  }
  try {
    const target = fs.realpathSync(path.resolve(skill.dir, file))
    if (outside(fs.realpathSync(skill.dir), target)) {
      return `error: ${file} is outside the ${name} skill's folder`
    }
    return clip(fs.readFileSync(target, "utf8"))
  } catch (error) {
    return `error: could not read ${file} from the ${name} skill: ${error instanceof Error ? error.message : String(error)}`
  }
}
