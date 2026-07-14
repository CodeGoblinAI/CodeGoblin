import type { RGBA } from "@opentui/core"
import { tint } from "../context/theme"

export function codeGoblinBrandPalette(theme: {
  primary: RGBA
  secondary: RGBA
  backgroundElement: RGBA
  textMuted: RGBA
}) {
  return {
    skin: theme.primary,
    facet: tint(theme.primary, theme.backgroundElement, 0.35),
    shadow: theme.textMuted,
    vest: theme.secondary,
    eye: theme.backgroundElement,
  }
}
