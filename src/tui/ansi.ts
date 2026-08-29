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
   * Turn OFF alternate scroll, and ask for no mouse reporting at all.
   *
   * Mouse reporting would give the app the wheel - and, unavoidably, the drag
   * with it, which is the terminal own text selection. Taking the wheel cost
   * the ability to highlight anything at all, which is a bad trade: reading
   * and copying output matters more than scrolling with a wheel.
   *
   * So the mouse stays entirely the terminal own. Alternate scroll (1007) is
   * what turns the wheel into arrow keys on the alternate screen, and those
   * arrows landed in the composer as prompt history - disabling it makes the
   * wheel do nothing rather than do damage. Scrolling moved to the keyboard.
   */
  /**
   * Bracketed paste: the terminal wraps pasted text in ESC[200~ ... ESC[201~.
   *
   * Without it a paste is indistinguishable from very fast typing, so a
   * hundred lines arrive as a hundred lines of keystrokes - newlines and
   * all, which submit the half-arrived prompt again and again.
   */
  pasteOn: `${ESC}?2004h`,
  pasteOff: `${ESC}?2004l`,
  /** Button and wheel reporting, SGR encoded - the app takes the mouse. */
  takeMouse: `${ESC}?1000h${ESC}?1006h`,
  ownMouse: `${ESC}?1007l`,
  releaseMouse: `${ESC}?1007h`,
}

/** 24-bit colour. Every modern terminal supports it. */
export const rgb = (r: number, g: number, b: number) => `${ESC}38;2;${r};${g};${b}m`
export const bold = `${ESC}1m`
export const dim = `${ESC}2m`
/** Reverse video, for a selected span in the composer. */
export const invert = `${ESC}7m`
export const noInvert = `${ESC}27m`

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
