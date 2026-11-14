/** ANSI Shadow. Kept as the header font from the previous TUI. */
export const WORDMARK = [
  " ██████╗ ██████╗ ██████╗ ███████╗ ██████╗  ██████╗ ██████╗ ██╗     ██╗███╗   ██╗",
  "██╔════╝██╔═══██╗██╔══██╗██╔════╝██╔════╝ ██╔═══██╗██╔══██╗██║     ██║████╗  ██║",
  "██║     ██║   ██║██║  ██║█████╗  ██║  ███╗██║   ██║██████╔╝██║     ██║██╔██╗ ██║",
  "██║     ██║   ██║██║  ██║██╔══╝  ██║   ██║██║   ██║██╔══██╗██║     ██║██║╚██╗██║",
  "╚██████╗╚██████╔╝██████╔╝███████╗╚██████╔╝╚██████╔╝██████╔╝███████╗██║██║ ╚████║",
  " ╚═════╝ ╚═════╝ ╚═════╝ ╚══════╝ ╚═════╝  ╚═════╝ ╚═════╝ ╚══════╝╚═╝╚═╝  ╚═══╝",
]

/** Narrow terminals get the plain name instead of a squashed wordmark. */
export const WORDMARK_WIDTH = 79
export const COMPACT = "C O D E G O B L I N"

export const TAGLINE = "your local AI goblin for code, images and agents"
export const HOME_TIP = "/ for commands  \u00b7  @ for files  \u00b7  shift+tab changes mode"

/**
 * The empty conversation: the wordmark over a gold rule, the tagline, a line
 * of how to start and where you are - set in the middle of the space above
 * the composer rather than hung from the top of it.
 *
 * Pieces drop out as the space shrinks (the place, then the tip, then the
 * rule), and a narrow terminal gets the plain name, so it never draws more
 * than `height` rows or wider than `width`.
 */
export function homeScreen(
  width: number,
  height: number,
  where: string,
  paint: { goblin: string; gold: string; dim: string; reset: string },
): string[] {
  const wide = width >= WORDMARK_WIDTH + 4
  const art = wide ? WORDMARK : [COMPACT]
  const artWidth = wide ? WORDMARK_WIDTH : COMPACT.length
  const centred = (text: string, length = [...text].length) => " ".repeat(Math.max(0, Math.floor((width - length) / 2))) + text
  const fits = (text: string) => [...text].length <= width - 2
  const block: string[] = art.map((row) => paint.goblin + centred(row, artWidth) + paint.reset)
  const extras: string[][] = []
  // In the order they are given up when there is no room.
  if (wide) extras.push([paint.gold + centred("\u2500".repeat(artWidth), artWidth) + paint.reset])
  if (fits(TAGLINE)) extras.push(["", paint.gold + centred(TAGLINE) + paint.reset])
  if (fits(HOME_TIP)) extras.push(["", paint.dim + centred(HOME_TIP) + paint.reset])
  if (where && fits(where)) extras.push([paint.dim + centred(where) + paint.reset])
  for (const extra of extras) {
    if (block.length + extra.length > height) break
    block.push(...extra)
  }
  const shown = block.slice(0, Math.max(1, height))
  // A little above the middle reads as centred once the composer is below it.
  const top = Math.max(0, Math.floor((height - shown.length) * 0.4))
  return [...Array.from({ length: top }, () => ""), ...shown]
}
