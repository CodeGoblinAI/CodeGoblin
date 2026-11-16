import { expect, test } from "bun:test"
import { WHEEL_BASE, wheelStep, type Wheel } from "../src/tui/wheel"

/** Notches `gap` ms apart, all one way; the lines each moved. */
function spin(notches: number, gap: number, room = 40, direction: 1 | -1 = 1): number[] {
  let wheel: Wheel | undefined
  const moved: number[] = []
  for (let n = 0; n < notches; n++) { const step = wheelStep(wheel, direction, 1000 + n * gap, room); wheel = step.wheel; moved.push(step.lines) }
  return moved
}

test("an unhurried wheel moves three lines a notch, however long it goes on", () => {
  expect(spin(20, 250)).toEqual(Array.from({ length: 20 }, () => WHEEL_BASE))
})

test("a short flick stays precise; a spin that keeps going covers ground, up to most of a screen a notch", () => {
  const moved = spin(30, 20)
  expect(moved.slice(0, 3)).toEqual([3, 3, 3])
  for (let n = 1; n < moved.length; n++) expect(moved[n]!).toBeGreaterThanOrEqual(moved[n - 1]!)
  expect(moved.at(-1)).toBe(38)
  // Thirty notches of a spin go far further than thirty slow ones: 90 lines against hundreds.
  expect(moved.reduce((sum, lines) => sum + lines, 0)).toBeGreaterThan(600)
})

test("a pause or a change of direction goes back to three lines", () => {
  let wheel: Wheel | undefined
  let at = 0
  const turn = (direction: 1 | -1, gap: number) => { at += gap; const step = wheelStep(wheel, direction, at, 40); wheel = step.wheel; return step.lines }
  for (let n = 0; n < 12; n++) turn(1, 20)
  expect(turn(1, 20)).toBeGreaterThan(20)
  expect(turn(1, 400)).toBe(WHEEL_BASE)
  for (let n = 0; n < 12; n++) turn(1, 20)
  expect(turn(-1, 20)).toBe(WHEEL_BASE)
})

test("a small window never moves more than it shows, and never less than three", () => {
  expect(Math.max(...spin(40, 10, 8))).toBe(6)
  expect(Math.max(...spin(40, 10, 3))).toBe(WHEEL_BASE)
})
