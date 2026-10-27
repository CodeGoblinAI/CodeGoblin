import { theme, dim, ansi } from "./ansi"
import { displayWidth, truncateToWidth, padToWidth } from "./width"

/**
 * A popup.
 *
 * There was no such thing here until now, which is why settings ended up as
 * two slash commands where one had to know the other's grammar - a shape
 * that invites exactly the bugs it looks like it would. The original has a
 * dialog stack and puts settings, sessions, memory and the diff viewer in
 * it; this is the same idea for a terminal we draw ourselves.
 *
 * The model is deliberately plain: a title, a list of rows, and which row is
 * selected. Everything that behaves differently - a diff, a settings list, a
 * session list - is a different set of rows, not a different widget. What
 * the app does when enter is pressed is decided by `kind`.
 */

export type Tone = "text" | "muted" | "gold" | "added" | "removed" | "heading"

export type DialogRow = {
  label: string
  /** Dimmer text at the right-hand end of the row. */
  hint?: string
  tone?: Tone
  /**
   * Rows the selection skips: headings, blank spacers, the body of a diff.
   * A list where the cursor can land on a heading feels broken in a way that
   * is hard to name and easy to notice.
   */
  inert?: boolean
  /** Whatever the caller needs back when this row is chosen. */
  value?: string
}

export type Dialog = {
  /** What the app should do on enter. The dialog itself does not care. */
  kind: string
  title: string
  rows: DialogRow[]
  index: number
  footer?: string
  size: "medium" | "large" | "full"
  /**
   * A row armed for a destructive key.
   *
   * Deleting is two presses of the same key, the way the original does it -
   * the row says so in between. A confirmation dialog on top of a dialog is
   * worse than the thing it protects against.
   */
  armed?: string
}

const WIDTHS = { medium: 60, large: 88, full: 0 } as const

export function dialogWidth(dialog: Dialog, cols: number): number {
  const wanted = dialog.size === "full" ? cols - 8 : WIDTHS[dialog.size]
  return Math.max(28, Math.min(wanted, cols - 6))
}

/** How many rows of content fit, leaving room for the frame and the footer. */
export function dialogHeight(dialog: Dialog, rows: number): number {
  const chrome = dialog.footer ? 5 : 4
  // Room is left for the prompt and the status bar beneath: a long list such
  // as /help or /skills used to draw its bottom edge over both.
  return Math.max(1, Math.min(dialog.rows.length, rows - chrome - 9))
}

function selectable(rows: DialogRow[]): number[] {
  return rows.map((row, index) => (row.inert ? -1 : index)).filter((index) => index >= 0)
}

export function open(
  kind: string,
  title: string,
  rows: DialogRow[],
  options: { footer?: string; size?: Dialog["size"]; selectedValue?: string } = {},
): Dialog {
  const choices = selectable(rows)
  const first = (options.selectedValue === undefined ? undefined : choices.find((index) => rows[index]!.value === options.selectedValue)) ?? choices[0] ?? 0
  return {
    kind,
    title,
    rows,
    index: first,
    footer: options.footer,
    size: options.size ?? "medium",
  }
}

/**
 * Move the selection, skipping anything inert.
 *
 * Stops at the ends rather than wrapping. Wrapping a long list means one key
 * press too many silently takes you from the top to the bottom, which is
 * only ever noticed after acting on the wrong row.
 */
export function move(dialog: Dialog, delta: number): Dialog {
  const options = selectable(dialog.rows)
  if (!options.length) return dialog
  const at = options.indexOf(dialog.index)
  const next = at === -1 ? 0 : Math.max(0, Math.min(options.length - 1, at + delta))
  // Moving the cursor disarms: arming a row and then walking away from it
  // must not leave the next press deleting something else.
  return { ...dialog, index: options[next], armed: undefined }
}

export function selected(dialog: Dialog): DialogRow | undefined {
  const row = dialog.rows[dialog.index]
  return row && !row.inert ? row : undefined
}

/** Replace the rows, keeping the selection where it can still go. */
export function withRows(dialog: Dialog, rows: DialogRow[]): Dialog {
  const options = selectable(rows)
  const index = options.includes(dialog.index) ? dialog.index : (options[0] ?? 0)
  return { ...dialog, rows, index, armed: undefined }
}

/**
 * The first row on screen.
 *
 * Keeps the selection in view and prefers a full window, so the list does
 * not shrink as the cursor nears the end - the same rule the palette uses,
 * for the same reason.
 */
export function firstVisible(dialog: Dialog, height: number): number {
  if (dialog.rows.length <= height) return 0
  return Math.max(0, Math.min(dialog.index - Math.floor(height / 2), dialog.rows.length - height))
}

function colourFor(tone: Tone | undefined, active: boolean): string {
  if (active) return theme.text
  switch (tone) {
    case "added":
      return theme.goblin
    case "removed":
      return theme.error
    case "gold":
      return theme.gold
    case "heading":
      return theme.gold
    case "muted":
      return theme.muted
    default:
      return theme.muted
  }
}

/**
 * The box, as lines.
 *
 * Returned rather than written so the caller can put it wherever it wants
 * and so this can be checked without a terminal.
 */
export function box(dialog: Dialog, cols: number, rows: number): string[] {
  const width = dialogWidth(dialog, cols)
  const inner = width - 2
  const height = dialogHeight(dialog, rows)
  const start = firstVisible(dialog, height)
  const shown = dialog.rows.slice(start, start + height)

  const rule = "─".repeat(inner)
  const lines: string[] = []

  lines.push(theme.borderStrong + "╭" + rule + "╮" + ansi.reset)

  // The title carries its own "esc" so a dialog never has to be guessed out of.
  lines.push(
    theme.borderStrong + "│" + ansi.reset +
      theme.gold + padToWidth(" " + truncateToWidth(dialog.title, inner - 7), inner - 5) + ansi.reset +
      dim + " esc " + ansi.reset +
      theme.borderStrong + "│" + ansi.reset,
  )
  lines.push(theme.borderStrong + "├" + rule + "┤" + ansi.reset)

  for (const [offset, row] of shown.entries()) {
    const index = start + offset
    const active = index === dialog.index && !row.inert
    const marker = active ? theme.goblin + "❯ " + ansi.reset : "  "

    // The hint sits hard right, so a column of them lines up whatever the
    // labels do. It gives up its space to the label rather than the other
    // way round: a truncated filename is worse than a truncated count.
    // An armed row says so where its hint was. Arming something and getting
    // no acknowledgement is how a second press becomes a surprise.
    const armed = dialog.armed !== undefined && dialog.armed === row.value
    const hint = armed ? "press again to delete" : (row.hint ?? "")
    // The label is measured first and the hint takes what is left. It was the
    // other way round in the code, whatever the comment said: /approvals showed
    // "As", "Appro" and "Fu" beside hints that ran the full width.
    // One column is kept clear before the right border, so a hint never touches it.
    const hintRoom = Math.max(0, inner - 3 - displayWidth(row.label) - 2)
    const hintWidth = hint ? Math.min(displayWidth(hint), hintRoom) : 0
    const labelWidth = Math.max(0, inner - 3 - hintWidth - (hintWidth ? 2 : 0))
    const label = padToWidth(truncateToWidth(row.label, labelWidth), labelWidth)
    const tone = armed ? theme.error : dim
    const tail = hintWidth ? "  " + tone + padToWidth(truncateToWidth(hint, hintWidth), hintWidth) + ansi.reset : ""

    lines.push(
      theme.borderStrong + "│" + ansi.reset +
        marker + colourFor(row.tone, active) + label + ansi.reset + tail + " " +
        theme.borderStrong + "│" + ansi.reset,
    )
  }

  if (dialog.rows.length > height) {
    const position = " " + (dialog.index + 1) + " of " + dialog.rows.length
    lines.push(
      theme.borderStrong + "│" + ansi.reset + dim + padToWidth(position, inner) + ansi.reset +
        theme.borderStrong + "│" + ansi.reset,
    )
  }

  if (dialog.footer) {
    lines.push(theme.borderStrong + "├" + rule + "┤" + ansi.reset)
    lines.push(
      theme.borderStrong + "│" + ansi.reset + dim + padToWidth(" " + truncateToWidth(dialog.footer, inner - 2), inner) +
        ansi.reset + theme.borderStrong + "│" + ansi.reset,
    )
  }

  lines.push(theme.borderStrong + "╰" + rule + "╯" + ansi.reset)
  return lines
}

const ESCAPE = new RegExp(String.fromCharCode(27) + "\\[[0-9;]*[a-zA-Z]", "g")

/** The text of a line we drew, without the colours. */
export function plain(line: string): string {
  return line.replace(ESCAPE, "")
}

/**
 * Put the box over the screen.
 *
 * The backdrop keeps showing through either side, dimmed - which is what
 * makes it read as a thing on top of the conversation rather than a new
 * screen. Compositing needs the plain text of what is underneath, so the
 * base line is stripped of its colours first; that is only safe because we
 * generated those escapes ourselves a moment ago.
 */
export function compose(base: string[], boxLines: string[], cols: number, rows: number): string[] {
  const width = displayWidth(plain(boxLines[0] ?? ""))
  const left = Math.max(0, Math.floor((cols - width) / 2))
  // A quarter down, like the original - a centred box sits low on a tall
  // terminal and the eye expects it higher than the middle.
  // Keep the composer, status and clickable toolbar visible beneath the
  // dialog. On an 80x24 terminal a long model list otherwise occupied row 21
  // and was composited through the controls it was meant to replace.
  const top = Math.max(0, Math.min(Math.floor(rows / 4), Math.max(0, rows - boxLines.length - 6)))

  const out = [...base]
  while (out.length < top + boxLines.length) out.push("")

  for (const [offset, boxLine] of boxLines.entries()) {
    const row = top + offset
    const under = padToWidth(plain(out[row] ?? ""), cols)
    const before = truncateToWidth(under, left)
    const afterStart = left + width
    const after = [...under].slice(afterStart).join("")
    out[row] =
      dim + padToWidth(before, left) + ansi.reset +
      boxLine +
      dim + after + ansi.reset
  }

  // Everything not under the box is dimmed too, so the box is the only thing
  // at full brightness and the eye goes straight to it.
  for (let row = 0; row < out.length; row++) {
    if (row >= top && row < top + boxLines.length) continue
    out[row] = dim + plain(out[row] ?? "") + ansi.reset
  }

  return out
}
