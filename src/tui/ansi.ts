/**
 * Terminal control, written directly rather than pulled from a framework.
 *
 * This is the whole surface a TUI actually needs to start: move the cursor,
 * clear, colour, and switch to the alternate screen. Everything visual is
 * built on these.
 */
const ESC = "\x1b["

export const ansi = {
  clear: `${ESC}2J${ESC}H`,
  hideCursor: `${ESC}?25l`,
  showCursor: `${ESC}?25h`,
  altScreen: `${ESC}?1049h`,
  mainScreen: `${ESC}?1049l`,
  moveTo: (row: number, col: number) => `${ESC}${row};${col}H`,
  reset: `${ESC}0m`,
}

/** 24-bit colour. Every modern terminal supports it; 256-colour fallback is not worth the branch yet. */
export const rgb = (r: number, g: number, b: number) => `${ESC}38;2;${r};${g};${b}m`
export const dim = `${ESC}2m`
export const bold = `${ESC}1m`

export const theme = {
  goblin: rgb(154, 219, 53),
  gold: rgb(212, 176, 106),
  text: rgb(220, 220, 220),
  muted: rgb(120, 120, 120),
  border: rgb(60, 70, 60),
}
