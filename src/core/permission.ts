import { homedir } from "node:os"
import path from "node:path"
import { loadConfig, type RuleAction } from "./config"
import { mostSpecific } from "./wildcard"

/**
 * Consent for tools that change things.
 *
 * Reading is free; writing and running commands are not. The model decides
 * what to call, so the guard belongs here rather than in the prompt - a
 * prompt can be talked around, this cannot.
 *
 * There are three answers, not two. "Allow once" lets a single call through
 * and asks again next time; "always" covers calls like this one for the rest
 * of the conversation, because asking on every write trains people to
 * approve without reading; "reject" refuses this call only. Only "always" is
 * sticky, which makes the rule easy to hold in your head: nothing is
 * remembered unless you said to remember it.
 *
 * Above all of that sit the rules in codegoblin.jsonc. A deny rule is never
 * asked about and no mode or earlier approval gets past it.
 */
export type Decision = "once" | "always" | "reject"

/** What each answer is called where a person has to read it. */
export const DECISIONS: { id: Decision; label: string; hint: string }[] = [
  { id: "once", label: "Allow once", hint: "just this one call" },
  { id: "always", label: "Allow for this session", hint: "stop asking about calls like this" },
  { id: "reject", label: "Reject", hint: "refuse, and tell the model so" },
]

/** Patterns and what to do when a shell command matches one. */
export type Rules = Record<string, RuleAction>

/** Who stopped a call: a rule in codegoblin.jsonc, plan mode, or the person asked. */
export type RefusedBy = "rule" | "plan" | "user"

/** Whether a call may run, and if not, the words the model is told and who stopped it. */
export type Verdict = { allowed: true } | { allowed: false; reason: string; by: RefusedBy; rule?: string }

/**
 * How a person is asked. `cover` is what "Allow for this session" would
 * approve, in words: `"git status"`, `github.com`, `every write_file call`.
 */
export type Ask = (tool: string, detail: string, cover: string, from?: string) => Promise<Decision>

/**
 * Tools that change nothing outside the conversation never prompt.
 *
 * Reading and searching are observation. todo_write sounds like a write but
 * only records the plan the user is already watching, so asking permission
 * for it is friction with nothing behind it.
 */
// Starting a subagent and collecting its result change nothing themselves; what
// a subagent then does is asked about call by call, the same as anything else.
const HARMLESS = new Set(["read_file", "list_files", "grep", "glob", "todo_write", "skill", "task", "task_result"])

const NEWLINE = String.fromCharCode(10)
const RETURN = String.fromCharCode(13)
const TAB = String.fromCharCode(9)
const BACKSLASH = String.fromCharCode(92)

/** The command a shell call carries, whether it arrived as the tool's JSON arguments or as plain text. */
export function commandOf(detail: string): string {
  try {
    const parsed = JSON.parse(detail) as { command?: unknown } | null
    if (parsed && typeof parsed === "object" && typeof parsed.command === "string") return parsed.command
  } catch {
    // Not JSON, so the detail is the command itself.
  }
  return detail
}

/**
 * A command broken at the places a shell starts another command.
 *
 * `git status & rd /s /q dist` is two commands to cmd.exe, and an approval for
 * the first must not quietly cover the second. Quoted text is kept whole, so an
 * ampersand inside a commit message stays part of the message. A redirect such
 * as `2>&1` is not a break.
 */
export function segmentsOf(command: string): string[] {
  const segments: string[] = []
  let current = ""
  let quote: string | undefined
  for (let index = 0; index < command.length; index++) {
    const char = command[index]!
    if (quote) {
      current += char
      if (char === quote) quote = undefined
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      current += char
      continue
    }
    const redirect = char === "&" && (command[index - 1] === ">" || command[index + 1] === ">")
    const isBreak = !redirect && (char === "&" || char === "|" || char === ";" || char === NEWLINE || char === RETURN)
    if (!isBreak) {
      current += char
      continue
    }
    if (current.trim()) segments.push(current.trim())
    current = ""
    // && and || are one operator, not two breaks with nothing between them.
    if ((char === "&" || char === "|") && command[index + 1] === char) index++
  }
  if (current.trim()) segments.push(current.trim())
  return segments
}

/** Words of one command, with quotes taken off and quoted spaces kept. */
function tokensOf(segment: string): string[] {
  const tokens: string[] = []
  let current = ""
  let quote: string | undefined
  let started = false
  for (const char of segment) {
    if (quote) {
      if (char === quote) quote = undefined
      else current += char
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      started = true
      continue
    }
    if (char === " " || char === TAB) {
      if (started) tokens.push(current)
      current = ""
      started = false
      continue
    }
    current += char
    started = true
  }
  if (started) tokens.push(current)
  return tokens
}

/** A program as a person would name it: no directory, no Windows extension, any case. */
function programName(token: string): string {
  const last = token.split(BACKSLASH).join("/").split("/").pop() ?? ""
  return last.toLowerCase().replace(/\.(exe|cmd|bat)$/, "")
}

/**
 * Interpreters that take the program to run as an argument.
 *
 * Approving one of these must never widen into approving the interpreter:
 * `node -e "console.log(1)"` and `node -e "require('fs').rmSync('x')"` share
 * every word a prefix would keep. The list is the fork's, which learned this
 * the hard way; cmd /c is added, because every shell call here runs in cmd.exe.
 */
const INLINE_RUNNERS = new Set([
  "ash", "bash", "bun", "dash", "deno", "node", "osascript", "perl", "php",
  "powershell", "pwsh", "py", "python", "python2", "python3", "ruby", "sh", "zsh",
])
const INLINE_FLAGS = new Set(["-c", "-e", "-p", "-r", "--eval", "--print", "-command", "-encodedcommand"])

export function runsInlineCode(tokens: string[]): boolean {
  const runner = tokens[0]
  if (!runner) return false
  const name = programName(runner)
  const rest = tokens.slice(1).map((token) => token.toLowerCase())
  if (name === "cmd") return rest.includes("/c") || rest.includes("/k")
  return INLINE_RUNNERS.has(name) && rest.some((token) => INLINE_FLAGS.has(token))
}

/**
 * How many words name a command, where the first word is not enough.
 *
 * `git status` and `git push` are different requests, and approving the first
 * must not approve the second. Curated for the tools used on this machine
 * rather than copied from the fork's generated table; anything not listed is
 * named by its first word. Interpreters take two, so approving one script is
 * not approving every script.
 */
const ARITY: Record<string, number> = {
  git: 2,
  gh: 3,
  npm: 2,
  "npm run": 3,
  pnpm: 2,
  "pnpm run": 3,
  yarn: 2,
  "yarn run": 3,
  bun: 2,
  "bun run": 3,
  bunx: 2,
  npx: 2,
  docker: 2,
  "docker compose": 3,
  cargo: 2,
  go: 2,
  pip: 2,
  pip3: 2,
  uv: 2,
  kubectl: 2,
  dotnet: 2,
  winget: 2,
  choco: 2,
  brew: 2,
  apt: 2,
  "apt-get": 2,
  node: 2,
  deno: 2,
  python: 2,
  python3: 2,
  py: 2,
  ruby: 2,
  perl: 2,
  php: 2,
  sh: 2,
  bash: 2,
  zsh: 2,
  powershell: 2,
  pwsh: 2,
}

function prefixOf(tokens: string[]): string[] {
  const named = [programName(tokens[0] ?? ""), ...tokens.slice(1)]
  for (let length = named.length; length > 0; length--) {
    const arity = ARITY[named.slice(0, length).join(" ")]
    if (arity !== undefined) return named.slice(0, arity)
  }
  return named.slice(0, 1)
}

function webfetchScope(detail: string): string {
  try {
    const parsed = JSON.parse(detail) as { url?: unknown }
    return "webfetch:" + new URL(String(parsed.url ?? "")).host
  } catch {
    // An unreadable target gets a scope of its own, so a malformed URL cannot
    // inherit the approval that was given to a real host.
    return "webfetch:?" + detail.slice(0, 80)
  }
}

/** One thing an approval can cover: its key among the approvals, and how a person would name it. */
type Scope = { key: string; words: string }

/**
 * What an approval for this call covers - every scope must be approved for the
 * call to pass without asking.
 *
 * For most tools it is the tool itself. webfetch is scoped to the host, because
 * "yes, fetch github.com" must never quietly become "yes, fetch anywhere".
 * shell is scoped to each command in the chain: its first words, or the exact
 * text when it runs inline code. It used to be the tool, so one approval for
 * `ls` approved every shell command for the rest of the session.
 */
function scopesFor(tool: string, detail: string): Scope[] {
  if (tool === "webfetch") {
    const key = webfetchScope(detail)
    return [{ key, words: key.startsWith("webfetch:?") ? "this exact address" : key.slice("webfetch:".length) }]
  }
  if (tool !== "shell") return [{ key: tool, words: "every " + tool + " call" }]
  const segments = segmentsOf(commandOf(detail))
  if (!segments.length) return [{ key: tool, words: "an empty command" }]
  const scopes = new Map<string, Scope>()
  for (const segment of segments) {
    const tokens = tokensOf(segment)
    let scope: Scope
    if (!tokens.length) {
      scope = { key: tool, words: "an empty command" }
    } else if (!runsInlineCode(tokens) && !(INLINE_RUNNERS.has(programName(tokens[0]!)) && (tokens[1] ?? "").startsWith("-")) && tokens.slice(1).some(leavesTheProject)) {
      // Reaching outside the project is approved for that program in those
      // folders. It used to be the exact command, so "Allow for this session"
      // on a write to Downloads asked again for the next command in Downloads.
      // It never widens to the program everywhere: approving type src\math.js
      // once covered type C:\anything.
      const prefix = prefixOf(tokens).join(" ")
      const folders = [...new Set(tokens.slice(1).filter(leavesTheProject).map(folderOf))].sort()
      scope = { key: tool + ":" + prefix + "@" + folders.join("|").toLowerCase(), words: '"' + prefix + '" in ' + folders.join(" and ") }
    } else if (runsInlineCode(tokens) || (INLINE_RUNNERS.has(programName(tokens[0]!)) && (tokens[1] ?? "").startsWith("-"))) {
      // An interpreter given flags before its script - powershell -NoProfile
      // -File x.ps1 - is approved exactly too. By its first two words, one
      // approved script covered every "powershell -NoProfile" command after it.
      scope = { key: tool + ":" + segment, words: "this exact " + programName(tokens[0]!) + " command" }
    } else {
      const prefix = prefixOf(tokens).join(" ")
      scope = { key: tool + ":" + prefix, words: '"' + prefix + '"' }
    }
    if (!scopes.has(scope.key)) scopes.set(scope.key, scope)
  }
  return [...scopes.values()]
}

const inWords = (scopes: Scope[]) => scopes.map((scope) => scope.words).join(" and ")

export function scopesOf(tool: string, detail: string): string[] {
  return scopesFor(tool, detail).map((scope) => scope.key)
}

/** The scopes as one line, for showing a person. */
export function scopeOf(tool: string, detail: string): string {
  return scopesOf(tool, detail).join(" & ")
}

/**
 * What "Allow for this session" would approve, in the words a person reads.
 *
 * The hint used to say "calls like this", which said nothing once an approval
 * stopped covering the whole tool: here it covers `git status`, there
 * github.com, and for a file write it really is every write.
 */
export function coverOf(tool: string, detail: string): string {
  return inWords(scopesFor(tool, detail))
}

/**
 * A refused call, labelled for a person: whose decision it was.
 *
 * Both surfaces used to say "refused" whatever happened, so a command a rule
 * stopped read as one you had turned down.
 */
export function refusalLabel(refusal: { by?: RefusedBy; rule?: string }): string {
  if (refusal.by === "rule") return refusal.rule ? `blocked by "${refusal.rule}"` : "blocked by a rule"
  if (refusal.by === "plan") return "not run while planning"
  return "refused"
}

type Match = { pattern: string; action: RuleAction }

/**
 * The strictest rule this command meets: deny, then ask, then nothing.
 *
 * Checked against the whole command and against each command in a chain. An
 * allow only means the rules do not block it - it never skips consent, so a
 * config file can refuse or ask on your behalf but can never approve.
 */
function ruleFor(command: string, rules: Rules): Match | undefined {
  const labelled: Record<string, Match> = {}
  for (const [pattern, action] of Object.entries(rules)) labelled[pattern] = { pattern, action }
  let strictest: Match | undefined
  for (const text of [command, ...segmentsOf(command)]) {
    const found = mostSpecific(text, labelled)
    if (!found || found.action === "allow") continue
    if (found.action === "deny") return found
    strictest ??= found
  }
  return strictest
}

/**
 * Commands that only look, which Approve for me runs without asking.
 *
 * Deliberately short. A command earns its place by being unable to change
 * anything however it is called. Anything that can - git branch -D, find
 * -delete, a test runner, which runs project code - still asks. Output sent to
 * a file, or a command run inside another, disqualifies the whole line.
 */
const READ_ONLY_PROGRAMS = new Set(["ls", "dir", "pwd", "cd", "cat", "type", "head", "tail", "wc", "rg", "grep", "findstr", "where", "which", "echo", "tree"])

/**
 * Whether an argument points outside the working directory: a drive, a share,
 * the home directory, an environment variable, a way up, or an absolute path.
 * Short Windows switches such as /s and /a:h are not paths.
 */
function leavesTheProject(token: string): boolean {
  const argument = /^\/[A-Za-z?]{1,2}:/.test(token) ? token.slice(token.indexOf(":") + 1) : token
  const value = argument.startsWith("-") && argument.includes("=") ? argument.slice(argument.indexOf("=") + 1) : argument
  if (/^[A-Za-z]:/.test(value)) return true
  if (value.startsWith(BACKSLASH + BACKSLASH) || value.startsWith("~")) return true
  if (value.includes("%") || value.includes("$")) return true
  if (value.split(BACKSLASH).join("/").split("/").includes("..")) return true
  if (value.startsWith("/") && !/^\/[A-Za-z?]{1,2}(:\S*)?$/.test(value)) return true
  return false
}
/**
 * The folder an outside argument names, spelled one way: %USERPROFILE%\Downloads
 * and C:\Users\me\Downloads are the same place, and a file stands for its folder.
 */
function folderOf(token: string): string {
  let value = token.startsWith("-") && token.includes("=") ? token.slice(token.indexOf("=") + 1) : token
  value = value.replace(/%([^%]+)%/g, (whole, name: string) => {
    const found = Object.keys(process.env).find((key) => key.toLowerCase() === name.toLowerCase())
    return found ? process.env[found]! : whole
  })
  value = value.replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g, (whole, name: string) => process.env[name] ?? whole)
  if (value.startsWith("~")) value = homedir() + value.slice(1)
  const normal = path.resolve(value)
  const last = normal.split(/[\\/]/).pop() ?? ""
  return last.includes(".") ? path.dirname(normal) : normal
}

const READ_ONLY_GIT = new Set(["status", "log", "diff", "show", "rev-parse", "ls-files", "blame"])

export function isReadOnlyCommand(command: string): boolean {
  // Joining one output stream to another (2>&1) or throwing output away
  // (>nul, 2>/dev/null) writes no file, so neither disqualifies the line. A
  // real model reached for git log ... 2>&1 while planning and was refused.
  const writesNothing = command
    .replace(/\d?>&\d/g, "")
    .replace(/\d?>\s*(nul|\/dev\/null)(?=\s|$|[&|;])/gi, "")
  if (writesNothing.includes(">") || command.includes("`") || command.includes("$(")) return false
  const segments = segmentsOf(command)
  if (!segments.length) return false
  return segments.every((segment) => {
    const tokens = tokensOf(segment)
    if (!tokens.length || runsInlineCode(tokens)) return false
    const program = programName(tokens[0]!)
    // A read-only command still reads, and outside the project that can be
    // the key store or ~/.ssh - cat of either would have run unasked. Only
    // arguments that stay in the working directory go through; anywhere else asks.
    if (tokens.slice(1).some(leavesTheProject)) return false
    if (program === "git") {
      // The first word that is not a flag is the subcommand; git -c can set a
      // pager or an alias, and its value is not a subcommand this list knows.
      const sub = tokens.slice(1).find((token) => !token.startsWith("-"))
      // -C, --git-dir and --work-tree point git at another repository.
      const unsafeFlag = tokens.some(
        (token) =>
          token.startsWith("--output") || token === "--ext-diff" || token === "-c" || token === "-C" ||
          token.startsWith("--git-dir") || token.startsWith("--work-tree"),
      )
      return sub !== undefined && READ_ONLY_GIT.has(sub) && !unsafeFlag
    }
    // rg --pre runs a program on every file it searches.
    if (program === "rg" && tokens.some((token) => token.startsWith("--pre"))) return false
    return READ_ONLY_PROGRAMS.has(program)
  })
}

/**
 * How much to ask - the three choices Codex offers.
 *
 * ask      Ask for approval: changes, commands and fetches all ask, and "Allow
 *          for this session" covers calls like the one approved.
 * approve  Approve for me: edits inside the working directory and plainly
 *          read-only commands go through; anything that could do harm asks.
 * full     Full access: nothing asks. The rules in codegoblin.jsonc still stop
 *          what they deny and ask about what they ask about.
 *
 * Planning is not a mode but a flag beside it, set by /plan: while it is on
 * nothing that changes anything runs, whichever mode is chosen.
 *
 * Per session and never persisted. Full access that quietly survived a
 * restart would be a nasty surprise, and it is the kind of setting people turn
 * on for one task and forget.
 */
export type PermissionMode = "ask" | "approve" | "full"

export const MODES: { id: PermissionMode; label: string; hint: string }[] = [
  { id: "ask", label: "Ask for approval", hint: "ask before changing files, running commands or using the internet" },
  { id: "approve", label: "Approve for me", hint: "only ask for actions that could be unsafe" },
  { id: "full", label: "Full access", hint: "never ask - only the rules in codegoblin.jsonc stop anything" },
]

export function nextMode(mode: PermissionMode): PermissionMode {
  const at = MODES.findIndex((entry) => entry.id === mode)
  return MODES[(at + 1) % MODES.length]!.id
}

export class Permissions {
  private granted = new Set<string>()
  mode: PermissionMode = "ask"
  /** Set by /plan: nothing that changes anything runs until the plan is agreed. */
  planning = false
  /**
   * Set by answering "for this session" to an autonomy checkpoint: the turn
   * is never paused again. Per session like everything else, and cleared by
   * reset with the standing approvals.
   */
  checkpointsOff = false

  /**
   * `rules` is where deny and ask patterns come from. Nothing by default, so a
   * Permissions built in a test is not governed by whoever runs the tests. The
   * app builds its own with `withConfig`, and a test holds both surfaces to it.
   */
  constructor(
    private ask: Ask,
    private rules: () => Rules = () => ({}),
  ) {}

  /** The rules in codegoblin.jsonc, read fresh on every call so an edit applies to the next command. */
  static withConfig(ask: Ask, file?: string): Permissions {
    return new Permissions(ask, () => {
      const config = loadConfig(file)
      // A partial parse must never turn a broken deny policy into full access.
      return config.problems.length ? { "*": "deny" } : config.permission.bash
    })
  }

  /**
   * The permissions a subagent works under: this conversation's rules, and its
   * mode, planning and approvals read live - switching mode mid-task applies to
   * the subagent's next call too, and an approval either of them gets holds for
   * both. Its questions carry its name, because a person can no longer tell
   * from the conversation which agent is asking.
   */
  forSubagent(name: string): Permissions {
    const parent = this
    const child = new Permissions((tool, detail, cover) => parent.ask(tool, detail, cover, name), this.rules)
    child.granted = this.granted
    Object.defineProperty(child, "mode", { get: () => parent.mode, set: (value: PermissionMode) => (parent.mode = value) })
    Object.defineProperty(child, "planning", { get: () => parent.planning, set: (value: boolean) => (parent.planning = value) })
    Object.defineProperty(child, "checkpointsOff", { get: () => parent.checkpointsOff, set: (value: boolean) => (parent.checkpointsOff = value) })
    return child
  }

  needsConsent(tool: string): boolean {
    return !HARMLESS.has(tool)
  }

  /** Re-evaluate a waiting request after a mode change, without prompting again. */
  automaticVerdict(tool: string, detail: string): Verdict | undefined {
    if (!this.needsConsent(tool)) return { allowed: true }

    // The rules come first - before the mode, before anything approved earlier
    // in the session, before anyone is asked. The fork learned that a command
    // which skipped rule evaluation was a command no rule could stop.
    const rule = tool === "shell" ? ruleFor(commandOf(detail), this.rules()) : undefined
    if (rule?.action === "deny") {
      return {
        allowed: false,
        by: "rule",
        rule: rule.pattern,
        reason: `not run: blocked by a rule in codegoblin.jsonc - "${rule.pattern}" denies this command`,
      }
    }

    // Planning refuses before anything is asked: the point is that nothing
    // changes until the plan is agreed. Looking still works - a read-only
    // command, or a page - so the plan can rest on what is actually there.
    const onlyLooks = tool === "webfetch" || (tool === "shell" && isReadOnlyCommand(commandOf(detail)))
    if (this.planning && !onlyLooks) {
      return {
        allowed: false,
        by: "plan",
        reason: "not run: planning is on, so nothing that changes files or runs commands is executed until the plan is agreed",
      }
    }

    // An ask rule means ask - in every mode, and even after an approval.
    const forced = rule?.action === "ask"
    if (!forced && this.mode === "full") return { allowed: true }
    const harmless = tool === "write_file" || tool === "edit_file" || (tool === "shell" && isReadOnlyCommand(commandOf(detail)))
    if (!forced && this.mode === "approve" && harmless) return { allowed: true }

    const scopes = scopesFor(tool, detail)
    if (!forced && scopes.every((scope) => this.granted.has(scope.key))) return { allowed: true }
    return undefined
  }

  async decide(tool: string, detail: string): Promise<Verdict> {
    const automatic = this.automaticVerdict(tool, detail)
    if (automatic) return automatic
    const scopes = scopesFor(tool, detail)
    const decision = await this.ask(tool, detail, inWords(scopes))
    if (decision === "reject") return { allowed: false, by: "user", reason: "refused by the user" }
    if (decision === "always") for (const scope of scopes) this.granted.add(scope.key)
    return { allowed: true }
  }

  /** Returns true when the tool may run. */
  async check(tool: string, detail: string): Promise<boolean> {
    return (await this.decide(tool, detail)).allowed
  }

  /** A new conversation starts with no standing approvals. */
  reset() {
    this.granted.clear()
    this.checkpointsOff = false
  }

  /**
   * Whether a long turn may keep going after this many tool calls.
   *
   * Asked through the same prompt as any tool, so both surfaces render it
   * with no new UI: "once" continues until the next window, "for this
   * session" turns checkpoints off, and anything else stops the turn.
   */
  async checkpoint(toolCalls: number, every: number): Promise<"continue" | "stop"> {
    if (this.checkpointsOff) return "continue"
    const decision = await this.ask(
      "autonomous run",
      `${toolCalls} tool calls this turn - keep going`,
      "future checkpoints",
    )
    if (decision === "always") this.checkpointsOff = true
    return decision === "reject" ? "stop" : "continue"
  }

  summary(): string[] {
    return [...this.granted].sort()
  }
}

/** Used where consent is not applicable, such as tests. */
export const allowAll = () => new Permissions(async () => "always")
