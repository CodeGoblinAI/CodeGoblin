/**
 * Terminal control, written directly rather than pulled from a framework.
 *
 * Colours come from core/theme, which the browser reads too, so /theme
 * means the same thing in either surface.
 */

import { paletteOf, DEFAULT_THEME } from "../core/theme"

const ESC = "\x1b["

export const ansi = {
  clear: `${ESC}2J${ESC}H`,
  hideCursor: `${ESC}?25l`,
  showCursor: `${ESC}?25h`,
  altScreen: `${ESC}?1049h`,
  mainScreen: `${ESC}?1049l`,
  moveTo: (row: number, col: number) => `${ESC}${row};${col}H`,
  reset: `${ESC}0m`,
  /**
   * Wheel reporting only (1000 = button events, 1006 = SGR encoding).
   *
   * Without this the terminal turns the wheel into arrow keys, which the
   * composer reads as prompt history - so scrolling the transcript walked
   * back through what you had already typed instead.
   */
  mouseOn: `${ESC}?1000h${ESC}?1006h`,
  mouseOff: `${ESC}?1006l${ESC}?1000l`,
}

/** 24-bit colour. Every modern terminal supports it. */
export const rgb = (r: number, g: number, b: number) => `${ESC}38;2;${r};${g};${b}m`
export const bold = `${ESC}1m`
export const dim = `${ESC}2m`

const hex = (value: string) =>
  rgb(
    parseInt(value.slice(1, 3), 16),
    parseInt(value.slice(3, 5), 16),
    parseInt(value.slice(5, 7), 16),
  )

/**
 * The colours in use, as ready-made escape sequences.
 *
 * Mutated in place by applyTheme rather than replaced, because every module
 * that draws holds a reference to this object - swapping it would leave half
 * the screen painted in the old theme.
 */
export const theme = {
  goblin: "",
  goblinBright: "",
  gold: "",
  text: "",
  muted: "",
  border: "",
  borderStrong: "",
  error: "",
  warning: "",
}

export function applyTheme(name: string) {
  const palette = paletteOf(name)
  theme.goblin = hex(palette.green)
  theme.goblinBright = hex(palette.greenBright)
  theme.gold = hex(palette.gold)
  theme.text = hex(palette.step12)
  theme.muted = hex(palette.step11)
  theme.border = hex(palette.step5)
  theme.borderStrong = hex(palette.step7)
  theme.error = hex(palette.red)
  theme.warning = hex(palette.orange)
}

applyTheme(DEFAULT_THEME)
