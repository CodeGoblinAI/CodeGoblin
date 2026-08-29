/**
 * Consent for tools that change things.
 *
 * Reading is free; writing and running commands are not. The model decides
 * what to call, so the guard belongs here rather than in the prompt - a
 * prompt can be talked around, this cannot.
 *
 * There are three answers, not two. "Allow once" lets a single call through
 * and asks again next time; "always" covers the tool for the rest of the
 * conversation, because asking on every write trains people to approve
 * without reading; "reject" refuses this call only. Only "always" is sticky,
 * which makes the rule easy to hold in your head: nothing is remembered
 * unless you said to remember it.
 */
export type Decision = "once" | "always" | "reject"

/** What each answer is called where a person has to read it. */
export const DECISIONS: { id: Decision; label: string; hint: string }[] = [
  { id: "once", label: "Allow once", hint: "just this one call" },
  { id: "always", label: "Allow for this session", hint: "stop asking about this tool" },
  { id: "reject", label: "Reject", hint: "refuse, and tell the model so" },
]

/**
 * Tools that change nothing outside the conversation never prompt.
 *
 * Reading and searching are observation. todo_write sounds like a write but
 * only records the plan the user is already watching, so asking permission
 * for it is friction with nothing behind it.
 */
const HARMLESS = new Set(["read_file", "list_files", "grep", "glob", "todo_write"])

/**
 * What a single approval covers.
 *
 * For most tools it is the tool itself: asking on every write trains people
 * to approve without reading, which is worse than asking once. webfetch is
 * the exception, because there the host is the decision. "Yes, fetch
 * github.com" must never quietly become "yes, fetch anywhere" - that is
 * exactly the route by which a README talks the model into posting what it
 * knows to someone else's server.
 */
export function scopeOf(tool: string, detail: string): string {
  if (tool !== "webfetch") return tool
  try {
    const parsed = JSON.parse(detail) as { url?: unknown }
    return tool + ":" + new URL(String(parsed.url ?? "")).host
  } catch {
    // An unreadable target gets a scope of its own, so a malformed URL cannot
    // inherit the approval that was given to a real host.
    return tool + ":?" + detail.slice(0, 80)
  }
}

/**
 * How much to ask.
 *
 * ask   - the default; the first call of each kind asks.
 * auto  - approve everything without asking. For a run you are watching.
 * plan  - refuse everything that changes anything, so the model can read,
 *         search and think out loud but cannot act.
 *
 * Per session and never persisted. Auto-approval that quietly survived a
 * restart would be a nasty surprise, and it is the kind of setting people
 * turn on for one task and forget.
 */
export type PermissionMode = "ask" | "auto" | "plan"

export const MODES: { id: PermissionMode; label: string; hint: string }[] = [
  { id: "ask", label: "ask", hint: "approve each kind of call once" },
  { id: "auto", label: "auto", hint: "approve everything, no prompts" },
  { id: "plan", label: "plan", hint: "read and think only, change nothing" },
]

export function nextMode(mode: PermissionMode): PermissionMode {
  const at = MODES.findIndex((entry) => entry.id === mode)
  return MODES[(at + 1) % MODES.length]!.id
}

export class Permissions {
  private granted = new Set<string>()
  mode: PermissionMode = "ask"

  constructor(private ask: (tool: string, detail: string) => Promise<Decision>) {}

  needsConsent(tool: string): boolean {
    return !HARMLESS.has(tool)
  }

  /** Returns true when the tool may run. */
  async check(tool: string, detail: string): Promise<boolean> {
    if (!this.needsConsent(tool)) return true

    // Plan mode refuses before anything is asked: the point is that nothing
    // changes, not that you are asked whether it may.
    if (this.mode === "plan") return false
    if (this.mode === "auto") return true

    const scope = scopeOf(tool, detail)
    if (this.granted.has(scope)) return true

    const decision = await this.ask(tool, detail)
    if (decision === "always") this.granted.add(scope)
    return decision !== "reject"
  }

  /** A new conversation starts with no standing approvals. */
  reset() {
    this.granted.clear()
  }

  summary(): string[] {
    return [...this.granted].sort()
  }
}

/** Used where consent is not applicable, such as tests. */
export const allowAll = () => new Permissions(async () => "always")
