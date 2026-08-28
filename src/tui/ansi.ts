/**
 * Terminal control, written directly rather than pulled from a framework.
 *
 * Colours are CodeGoblin's own charcoal theme, taken from the theme
 * definition in the existing app so both look like the same product:
 * neutral greys, green reserved for identity and active state, gold for
 * accents.
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

export const palette = {
  step1: "#16181c",
  step2: "#1a1d22",
  step3: "#22262c",
  step5: "#333842",
  step7: "#4b515d",
  step11: "#9aa1ab",
  step12: "#e8eaed",
  green: "#62f56e",
  greenBright: "#92ff9b",
  gold: "#d4b06a",
  red: "#ff6f7d",
  orange: "#ffb84d",
}

export const theme = {
  goblin: hex(palette.green),
  goblinBright: hex(palette.greenBright),
  gold: hex(palette.gold),
  text: hex(palette.step12),
  muted: hex(palette.step11),
  border: hex(palette.step5),
  borderStrong: hex(palette.step7),
  error: hex(palette.red),
  warning: hex(palette.orange),
}
