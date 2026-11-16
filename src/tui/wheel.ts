/**
 * How far one notch of the mouse wheel moves the conversation.
 *
 * A fixed three lines is right for reading and hopeless for getting anywhere: a long conversation is
 * thousands of lines, and going back to the start was hundreds of notches. So the step grows while the wheel
 * keeps turning the same way without a pause - a slow turn still moves three lines at a time, a hard spin is
 * soon moving most of a screen per notch - and drops back to three the moment the wheel rests or turns round.
 *
 * Pure: the state goes in and comes out, so the rule is tested without a terminal or a clock.
 */
export type Wheel = { at: number; direction: 1 | -1; run: number }

/** Lines for an unhurried notch. */
export const WHEEL_BASE = 3
/** Notches this close together are one spin. A hand turning a wheel notch by notch is slower than this. */
const SAME_SPIN_MS = 110
/** Notches of a spin that still move the base amount, so a short flick stays precise. */
const STEADY = 3

export function wheelStep(last: Wheel | undefined, direction: 1 | -1, now: number, room: number): { lines: number; wheel: Wheel } {
  const spinning = last !== undefined && last.direction === direction && now - last.at >= 0 && now - last.at <= SAME_SPIN_MS
  const run = spinning ? last!.run + 1 : 0
  // Never more than a screen less two lines per notch: the eye keeps its place.
  const most = Math.max(WHEEL_BASE, room - 2)
  const lines = run < STEADY ? WHEEL_BASE : Math.min(most, WHEEL_BASE + Math.round((run - STEADY + 1) * 2.5))
  return { lines, wheel: { at: now, direction, run } }
}
