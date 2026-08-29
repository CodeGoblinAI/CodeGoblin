/**
 * Consent for tools that change things.
 *
 * Reading is free; writing and running commands are not. The model decides
 * what to call, so the guard belongs here rather than in the prompt - a
 * prompt can be talked around, this cannot.
 *
 * Granularity is per tool, per session: the first write asks, and approving
 * covers writes for the rest of that conversation. Asking every single time
 * trains people to approve without reading, which is worse than asking once.
 */
export type Decision = "allow" | "deny"

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

export class Permissions {
  private granted = new Set<string>()
  private denied = new Set<string>()

  constructor(private ask: (tool: string, detail: string) => Promise<Decision>) {}

  needsConsent(tool: string): boolean {
    return !HARMLESS.has(tool)
  }

  /** Returns true when the tool may run. */
  async check(tool: string, detail: string): Promise<boolean> {
    if (!this.needsConsent(tool)) return true
    const scope = scopeOf(tool, detail)
    if (this.granted.has(scope)) return true
    if (this.denied.has(scope)) return false

    const decision = await this.ask(tool, detail)
    if (decision === "allow") {
      this.granted.add(scope)
      return true
    }
    this.denied.add(scope)
    return false
  }

  /** A new conversation starts with no standing approvals. */
  reset() {
    this.granted.clear()
    this.denied.clear()
  }

  summary(): string[] {
    return [...this.granted].sort()
  }
}

/** Used where consent is not applicable, such as tests. */
export const allowAll = () => new Permissions(async () => "allow")
