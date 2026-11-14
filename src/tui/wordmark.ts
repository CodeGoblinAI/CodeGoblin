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
 * One thing worth knowing, under the start line - a different one each time, as the fork's home screen has.
 * Each names something that is here and works; nothing is advertised that is not.
 */
export const TIPS = [
  "F2 switches to your next recent model",
  "ctrl+x then m opens the models; ctrl+f there stars a favourite",
  "drop or paste a picture to show it to the model",
  "a line starting with ! runs that command in your shell",
  "/effort sets how hard this model thinks",
  "/undo takes back the files the last turn changed",
  "/resume reopens a conversation; ctrl+p there pins it",
  "/search finds anything said in this conversation",
  "/diff shows what the last turn changed",
  "/compact shrinks a long conversation to a summary",
  "/memory keeps facts from one conversation to the next",
  "/boost lets the model hand work to subagents",
  "/theme changes the colours; /settings has the rest",
  "esc twice stops a turn; what was done so far is kept",
  "/connect adds a provider's key; /model picks from what you have",
]
let tip = ""
/** Sets the tip the home screen shows; empty for none. */
export function setHomeTip(text: string) {
  tip = text
}
export const pickTip = (random: () => number = Math.random) => TIPS[Math.floor(random() * TIPS.length)] ?? ""

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

/**
 * The empty conversation as the whole window is laid out: the wordmark block,
 * then - straight under it, not at the bottom of the terminal - the composer,
 * with the folder and its branch on the last row. The prompt is where the eye
 * already is, and the window does not look like a logo over a void.
 *
 * `room` is the rows there would be above the composer were it at the bottom;
 * `taken` is rows something else needs between the block and the composer
 * (the command list). `above` is drawn before the composer and `below` after
 * it, and together with `taken` they always come to exactly `room` rows, so
 * the frame is the same height as any other. The block stays where it is when
 * the command list opens: the list takes its rows from below, and only lifts
 * the block when there is nowhere else to find them.
 */
export function homeLayout(
  width: number,
  room: number,
  taken: number,
  where: string,
  paint: { goblin: string; gold: string; dim: string; reset: string },
  /** Rows of notices drawn just above the composer (counted in `taken`): they use the blank row, so the composer never moves. */
  notice = 0,
): { above: string[]; below: string[] } {
  const space = Math.max(1, room - taken)
  // Laid out as if the notices were not there, so the block and the composer stay put when one appears.
  const full = space + notice
  // The block without the place line and without padding; one blank row keeps it off the composer.
  const block = homeScreen(width, Math.max(1, full - 1), "", paint).filter((line, index, all) => line !== "" || all.slice(0, index).some((each) => each !== ""))
  const gap = full > block.length ? 1 : 0
  const settled = Math.max(0, Math.floor((room - block.length - gap) * 0.38))
  const top = Math.max(0, Math.min(settled, full - block.length - gap))
  const above = [...Array.from({ length: top }, () => ""), ...block.slice(0, full), ...(gap ? [""] : [])]
  // The notices sit just above the composer: their rows come from the blank under the block, then the padding on top.
  for (let index = 0; index < notice && above.length; index++) {
    const blank = above.at(-1) === "" ? above.length - 1 : above.indexOf("")
    above.splice(blank >= 0 ? blank : above.length - 1, 1)
  }
  let rest = Math.max(0, full - top - Math.min(block.length, full) - gap)
  // The tip goes under the start line when the window has rows to spare (judged on the whole room, so opening
  // the command list does not make it come and go). Its row comes from below the composer, which moves down
  // one; the wordmark stays exactly where it was.
  const tipText = "tip: " + tip
  if (tip && notice === 0 && [...tipText].length <= width - 2 && room - top - block.length - gap >= 4 && rest >= 1 && block.length >= 3) {
    above.splice(above.length - gap, 0, paint.dim + " ".repeat(Math.max(0, Math.floor((width - [...tipText].length) / 2))) + tipText + paint.reset)
    rest -= 1
  }
  const place = where && [...where].length <= width - 4 && rest >= 2 ? [paint.dim + "  " + where + paint.reset] : []
  return { above, below: [...Array.from({ length: rest - place.length }, () => ""), ...place] }
}
