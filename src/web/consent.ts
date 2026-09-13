import { Permissions, DECISIONS, type Decision } from "../core/permission"

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
  private waiting = new Map<string, (decision: Decision) => void>()

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
      (tool, detail, cover) =>
        new Promise<Decision>((resolve) => {
          const id = sessionId + ":" + tool
          this.waiting.set(id, resolve)
          this.streams.get(sessionId)?.({ type: "permission", id, tool, detail, cover })
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
    const resolve = this.waiting.get(id)
    if (!resolve) return false
    this.waiting.delete(id)
    resolve(DECISIONS.some((choice) => choice.id === decision) ? (decision as Decision) : "reject")
    return true
  }

  /** Refuses whatever a conversation is still waiting on, so an abandoned turn cannot hang. */
  abandon(sessionId: string) {
    for (const [id, resolve] of this.waiting) {
      if (id.startsWith(sessionId + ":")) {
        resolve("reject")
        this.waiting.delete(id)
      }
    }
  }

  /** The questions still waiting on an answer. */
  pending(): string[] {
    return [...this.waiting.keys()]
  }
}
