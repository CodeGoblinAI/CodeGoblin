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

/** Tools that only observe never prompt. */
const READ_ONLY = new Set(["read_file", "list_files", "grep", "glob"])

export class Permissions {
  private granted = new Set<string>()
  private denied = new Set<string>()

  constructor(private ask: (tool: string, detail: string) => Promise<Decision>) {}

  needsConsent(tool: string): boolean {
    return !READ_ONLY.has(tool)
  }

  /** Returns true when the tool may run. */
  async check(tool: string, detail: string): Promise<boolean> {
    if (!this.needsConsent(tool)) return true
    if (this.granted.has(tool)) return true
    if (this.denied.has(tool)) return false

    const decision = await this.ask(tool, detail)
    if (decision === "allow") {
      this.granted.add(tool)
      return true
    }
    this.denied.add(tool)
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
