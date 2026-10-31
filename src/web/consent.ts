import { Permissions, DECISIONS, askedFor, type Decision, type PermissionMode } from "../core/permission"
import type { AskUser } from "../core/question"

/**
 * Consent for browser conversations.
 *
 * One Permissions per conversation, so "Allow for this session" lasts as long
 * as the conversation does. The question it asks has to go out on the request
 * that is running now: every message opens its own event stream and closes it
 * when its reply ends, so consent that held on to the first message's stream
 * asked every later question down a stream that was already closed - and the
 * browser showed "Invalid state: Controller is already closed" where a prompt
 * should have been.
 *
 * The browser answers over a second request rather than the stream, because
 * the stream is one-way. A question waits here until it is answered or the
 * turn is abandoned.
 */
export class BrowserConsent {
  private permissions = new Map<string, Permissions>()
  private streams = new Map<string, (event: unknown) => void>()
  private waiting = new Map<string, { sessionId: string; tool: string; detail: string; resolve: (decision: Decision) => void }>()
  /** Makes every question's id its own: a subagent and the main agent can ask about the same tool at once. */
  private asked = 0

  /**
   * The conversation's permissions, asking down the stream of the message that
   * is running now.
   *
   * withConfig rather than new: the deny rules in codegoblin.jsonc have to
   * reach every browser session's agent, and a test fails if a surface builds
   * one without them.
   */
  forSession(sessionId: string, send: (event: unknown) => void): Permissions {
    this.streams.set(sessionId, send)
    const existing = this.permissions.get(sessionId)
    if (existing) return existing
    const created = Permissions.withConfig(
      (tool, detail, cover, from) =>
        new Promise<Decision>((resolve) => {
          const id = sessionId + ":" + tool + ":" + ++this.asked
          this.waiting.set(id, { sessionId, tool, detail, resolve })
          // `asked` is the same readable summary the TUI shows; `detail` stays raw.
          this.streams.get(sessionId)?.({ type: "permission", id, tool, detail, asked: askedFor(tool, detail), cover, ...(from ? { from } : {}) })
        }),
    )
    this.permissions.set(sessionId, created)
    return created
  }

  /**
   * An answer from the browser. False when nothing was waiting on that id.
   *
   * Anything unrecognised is a refusal: a malformed answer must never be read
   * as consent.
   */
  answer(id: string, decision: unknown): boolean {
    const waiting = this.waiting.get(id)
    if (!waiting) return false
    this.waiting.delete(id)
    waiting.resolve(DECISIONS.some((choice) => choice.id === decision) ? (decision as Decision) : "reject")
    return true
  }

  /** Refuses whatever a conversation is still waiting on, so an abandoned turn cannot hang. */
  abandon(sessionId: string) {
    for (const [id, waiting] of this.questions) {
      if (waiting.sessionId !== sessionId) continue
      this.questions.delete(id)
      waiting.resolve(undefined)
    }
    for (const [id, waiting] of this.waiting) {
      if (waiting.sessionId === sessionId) {
        waiting.resolve("reject")
        this.waiting.delete(id)
      }
    }
  }

  /** The questions still waiting on an answer. */
  pending(): string[] {
    return [...this.waiting.keys()]
  }

  private questions = new Map<string, { sessionId: string; resolve: (answer: string[] | undefined) => void }>()

  /**
   * The model's question tool for a conversation: the question goes down the
   * stream of the message running now, and waits for /api/question. A stopped
   * turn, or an abandoned one, takes its question with it.
   */
  askerFor(sessionId: string, send: (event: unknown) => void): AskUser {
    this.streams.set(sessionId, send)
    return (question, signal) =>
      new Promise((resolve) => {
        if (signal?.aborted) return resolve(undefined)
        const id = sessionId + ":question:" + ++this.asked
        this.questions.set(id, { sessionId, resolve })
        signal?.addEventListener("abort", () => { if (this.questions.delete(id)) resolve(undefined) }, { once: true })
        this.streams.get(sessionId)?.({ type: "question", id, question })
      })
  }

  /**
   * The browser's answer: the labels picked or the words typed, or nothing for
   * dismissed. Anything that is not a list of short strings counts as dismissed.
   */
  answerQuestion(id: string, answer: unknown): boolean {
    const waiting = this.questions.get(id)
    if (!waiting) return false
    this.questions.delete(id)
    const valid = Array.isArray(answer) && answer.length > 0 && answer.length <= 6 && answer.every((each) => typeof each === "string" && each.trim() && each.length <= 2000)
    waiting.resolve(valid ? (answer as string[]).map((each) => each.trim()) : undefined)
    return true
  }

  setMode(sessionId: string, mode: PermissionMode): boolean {
    const permissions = this.permissions.get(sessionId)
    if (!permissions) return false
    permissions.mode = mode
    for (const [id, waiting] of this.waiting) {
      if (waiting.sessionId !== sessionId) continue
      const verdict = permissions.automaticVerdict(waiting.tool, waiting.detail)
      if (!verdict) continue
      this.waiting.delete(id)
      this.streams.get(sessionId)?.({ type: "permission_resolved", id, allowed: verdict.allowed })
      waiting.resolve(verdict.allowed ? "once" : "reject")
    }
    return true
  }
}
