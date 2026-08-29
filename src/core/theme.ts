/**
 * Named palettes.
 *
 * The TUI and the browser were each carrying their own copy of the same
 * colours, which is fine until one of them changes. Both read from here now,
 * so /theme means the same thing in either surface.
 *
 * Every palette defines the full set. A theme that fills in half the tokens
 * and inherits the rest looks like a bug the first time someone picks it.
 */
export type Palette = {
  step1: string
  step2: string
  step3: string
  step5: string
  step7: string
  step11: string
  step12: string
  green: string
  greenBright: string
  gold: string
  red: string
  orange: string
}

export const THEMES: Record<string, { label: string; palette: Palette }> = {
  goblin: {
    label: "charcoal and green, the default",
    palette: {
      step1: "#16181c", step2: "#1a1d22", step3: "#22262c", step5: "#333842", step7: "#4b515d",
      step11: "#9aa1ab", step12: "#e8eaed",
      green: "#62f56e", greenBright: "#92ff9b", gold: "#d4b06a", red: "#ff6f7d", orange: "#ffb84d",
    },
  },
  midnight: {
    label: "deep blue, cooler and quieter",
    palette: {
      step1: "#0d1117", step2: "#121821", step3: "#19212c", step5: "#2b3542", step7: "#3f4a5a",
      step11: "#8b97a8", step12: "#e3e9f2",
      green: "#4dd6c1", greenBright: "#7ff0de", gold: "#9db8ff", red: "#ff7b8a", orange: "#ffc266",
    },
  },
  ember: {
    label: "warm dark, amber accents",
    palette: {
      step1: "#17130f", step2: "#1d1814", step3: "#26201a", step5: "#3a3128", step7: "#54473a",
      step11: "#ad9e8d", step12: "#f2e9df",
      green: "#ffa447", greenBright: "#ffc178", gold: "#e8c17a", red: "#ff7a6b", orange: "#ffd48a",
    },
  },
  paper: {
    label: "light, for a bright room",
    palette: {
      step1: "#fbfaf7", step2: "#f3f1ec", step3: "#e8e5dd", step5: "#d4cfc4", step7: "#b3ac9e",
      step11: "#6b6558", step12: "#241f18",
      green: "#1c7f37", greenBright: "#15602a", gold: "#9a6b16", red: "#b3261e", orange: "#8a5a00",
    },
  },
}

export const DEFAULT_THEME = "goblin"

export function themeNames(): string[] {
  return Object.keys(THEMES)
}

export function paletteOf(name: string): Palette {
  return (THEMES[name] ?? THEMES[DEFAULT_THEME]!).palette
}

export function isTheme(name: string): boolean {
  return Object.hasOwn(THEMES, name)
}
