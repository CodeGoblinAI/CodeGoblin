/**
 * A provider gone quiet.
 *
 * Nothing waited on the network had a limit: a provider that took the request and then sent nothing - an
 * overloaded route does it - held the turn for as long as anyone let it, with a spinner that looked exactly
 * like a model thinking. From QUIET_FROM_MS the surfaces are told how long it has been silent, and after five
 * minutes of silence it is given up on. A model reasoning in silence can be quiet for a minute or two; five
 * minutes with not one byte is not that.
 */
const QUIET_FROM_MS = 20_000
const QUIET_STEP_MS = 10_000
/** Five minutes; a test sets it shorter, and the notices scale with it. */
const stallMs = () => Number(process.env.CG_STALL_MS) || 300_000

export class Stalled extends Error {}

/**
 * Waits for one network step, saying every ten seconds from twenty on that it is still waiting, and giving
 * up after the limit: `giveUp` ends the request, and a Stalled error says what happened.
 *
 * `endless` never gives up. A model on this machine sends nothing at all while it reads a long prompt, and on
 * a CPU that can take many minutes; its server failing is seen as a failed connection, not as silence.
 */
export async function* patiently<T>(step: Promise<T>, giveUp: () => void, label: string, { endless = false } = {}): AsyncGenerator<{ type: "quiet"; ms: number; endless?: boolean }, T> {
  const usual = stallMs()
  const limit = endless ? Number.POSITIVE_INFINITY : usual
  const from = Math.min(QUIET_FROM_MS, usual / 4), every = Math.min(QUIET_STEP_MS, usual / 4)
  let quiet = 0
  for (;;) {
    let timer: ReturnType<typeof setTimeout> | undefined
    const next = Math.min(quiet ? every : from, limit - quiet)
    const outcome = await Promise.race([
      step.then((value) => ({ value })),
      new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), next) }),
    ]).finally(() => clearTimeout(timer))
    if (outcome) return outcome.value
    quiet += next
    if (quiet >= limit) {
      giveUp()
      step.catch(() => {})
      const minutes = Math.round(limit / 60_000)
      const seconds = Math.round(limit / 1000)
      const span = limit < 60_000 ? seconds + (seconds === 1 ? " second" : " seconds") : minutes + (minutes === 1 ? " minute" : " minutes")
      throw new Stalled(`${label} sent nothing for ${span}, so CG-Next stopped waiting for it. Nothing is lost: send the prompt again, or pick another model with /model.`)
    }
    yield { type: "quiet", ms: quiet, ...(endless ? { endless: true } : {}) }
  }
}

/** The same wait, for a caller with nowhere to say it is still waiting. */
export async function within<T>(step: Promise<T>, giveUp: () => void, label: string, options: { endless?: boolean } = {}): Promise<T> {
  const waiting = patiently(step, giveUp, label, options)
  for (;;) {
    const next = await waiting.next()
    if (next.done) return next.value
  }
}
