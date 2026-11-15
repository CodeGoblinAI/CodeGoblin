/**
 * What happens when something throws that nothing caught.
 *
 * Left alone, the runtime prints the error into the app's own screen - where the next redraw paints over
 * it - and ends the process there, with the terminal still in the app's screen and its mouse still taken.
 * The person is left looking at a dead picture of the app with a shell prompt drawn through it, and
 * nothing anywhere says what went wrong.
 *
 * So: every such error is written to a log file, with where it came from. One error does not end the
 * conversation - it is shown in the status line and the app carries on. Errors that keep coming (or one
 * thrown by drawing the screen itself, which would otherwise repeat forever) do end it, but properly: the
 * terminal is handed back first, and the error is printed where it can be read.
 */
import fs from "node:fs"
import path from "node:path"

/** How many errors inside `WINDOW_MS` mean the app is no longer usable. */
export const TOO_MANY = 4
export const WINDOW_MS = 10_000

export function errorText(error: unknown): string {
  if (error instanceof Error) return error.stack && error.stack.includes(error.message) ? error.stack : `${error.name}: ${error.message}${error.stack ? "\n" + error.stack : ""}`
  if (typeof error === "string") return error || "(an empty error)"
  try { return JSON.stringify(error) ?? String(error) } catch { return String(error) }
}

/** The one line for the status bar: what broke, without the stack. */
export function errorLine(error: unknown): string {
  const first = (error instanceof Error ? error.message || error.name : errorText(error)).split("\n")[0]!.trim()
  return first.length > 90 ? first.slice(0, 89) + "…" : first
}

export function logEntry(kind: string, error: unknown, at: Date, context = ""): string {
  return `${at.toISOString()}  ${kind}${context ? "  (" + context + ")" : ""}\n${errorText(error)}\n\n`
}

/** Appends to the log and returns the file, or undefined when it could not be written. */
export function writeCrash(file: string, entry: string): string | undefined {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.appendFileSync(file, entry)
    return file
  } catch { return undefined }
}

/**
 * Decides, error by error, whether the app can carry on. `times` is kept by the caller between calls.
 * An error while the screen is being drawn is always the end: the next redraw would only throw it again.
 */
export function carryOn(times: number[], now: number, drawing: boolean): boolean {
  times.push(now)
  while (times.length && now - times[0]! > WINDOW_MS) times.shift()
  return !drawing && times.length < TOO_MANY
}

/** What is printed, on the ordinary screen, when the app does have to end. */
export function farewell(kind: string, error: unknown, file: string | undefined): string {
  return `\nCodeGoblin stopped on an error it did not expect (${kind}):\n\n${errorText(error)}\n\n` +
    (file ? `This is also saved in ${file}\n` : "") +
    "Your conversation is saved as it goes: start again and /resume picks it up.\n"
}
