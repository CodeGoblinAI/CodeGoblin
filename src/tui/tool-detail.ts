/**
 * What a finished tool call shows under its row.
 *
 * One line per call - "shell git status -> On branch main" - said that
 * something ran, but not what came of it: a command's output, what a file now
 * says, what was answered. The fork shows those under the call, and that is
 * how you follow what the agent is doing without opening anything. Kept short:
 * a few lines and a count of the rest, so a long build log does not push the
 * conversation off the screen.
 */
export type DetailLine = { text: string; tone?: "add" | "remove" | "more" }
export type ToolDetail = { summary: string; lines: DetailLine[] }

const NEWLINE = String.fromCharCode(10)

function parse(args: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(args)
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/** Up to `max` lines, then one saying how many more there were. Trailing blank lines are not content. */
function capped(text: string, max: number, tone?: DetailLine["tone"]): DetailLine[] {
  const all = text.replace(/\r\n?/g, NEWLINE).split(NEWLINE)
  while (all.length && !all.at(-1)!.trim()) all.pop()
  const shown = all.slice(0, max).map((line) => ({ text: line.replace(/\t/g, "  "), ...(tone ? { tone } : {}) }))
  const rest = all.length - shown.length
  return rest > 0 ? [...shown, { text: `… ${rest} more line${rest === 1 ? "" : "s"}`, tone: "more" as const }] : shown
}

export function toolDetail(name: string, argsText: string, result: string, max = 6): ToolDetail {
  const args = parse(argsText)
  const first = (result.split(NEWLINE)[0] ?? "").trim()
  if (/^(error|stopped)/.test(result)) return { summary: "", lines: capped(result, 3) }

  // A job's first line is its state ("started job1 in the background: ...", "job1: running for 4s"); the
  // output under it is what it printed.
  if ((name === "shell" && args.background === true) || name === "job_output" || name === "job_stop") {
    const rest = result.split(NEWLINE).slice(1).filter((line) => !/^\(still running\. job_output/.test(line)).join(NEWLINE)
    const summary = name === "shell" ? (/^(started job\d+|job\d+ ended straight away \([^)]*\))/.exec(first)?.[1] ?? first) : first
    return { summary: summary.length > 70 ? summary.slice(0, 69) + "…" : summary, lines: rest.trim() && !/^\((no output|nothing new)/.test(rest.trim()) ? capped(rest, max) : [] }
  }

  if (name === "shell") {
    // A command that outlived its wait: the row says it is still going, and as which job, rather than
    // leaving that at the bottom of output nobody scrolls to.
    const handed = /\s*\.\.\. still running after ([^.]+)\. It was not stopped: it carries on in the background as (job\d+)\.[\s\S]*$/.exec(result)
    if (handed) {
      const printed = result.slice(0, handed.index)
      return { summary: "still running after " + handed[1] + " - carries on as " + handed[2] + " (/jobs)", lines: printed.trim() && printed.trim() !== "(no output yet)" ? capped(printed, max) : [] }
    }
    // The exit code is the verdict, so it goes on the row; the output goes under it.
    const code = /\nexit code (\S+)\s*$/.exec(result)?.[1]
    const output = code ? result.slice(0, result.lastIndexOf(NEWLINE + "exit code")) : result
    if (!output.trim() || output.trim() === "(no output)") return { summary: code ? "exit code " + code : "no output", lines: [] }
    return { summary: code ? "exit code " + code : "", lines: capped(output, max) }
  }

  if (name === "write_file" && typeof args.content === "string") {
    const lines = capped(args.content, max)
    const width = String(lines.filter((line) => line.tone !== "more").length).length
    return { summary: "", lines: lines.map((line, index) => (line.tone === "more" ? line : { text: String(index + 1).padStart(width) + "  " + line.text })) }
  }

  if (name === "edit_file" && typeof args.old_string === "string" && typeof args.new_string === "string") {
    const half = Math.max(1, Math.floor(max / 2))
    return { summary: "", lines: [...capped(args.old_string, half, "remove"), ...capped(args.new_string, half, "add")].map((line) => line.tone === "remove" ? { ...line, text: "- " + line.text } : line.tone === "add" ? { ...line, text: "+ " + line.text } : line) }
  }

  if (name === "question") {
    const answered = /^The user answered "[\s\S]*?": ([\s\S]*)\.$/.exec(result.trim())?.[1]
    if (answered) return { summary: "answered " + answered.replace(/"/g, ""), lines: [] }
    if (/^The user dismissed/.test(result)) return { summary: "dismissed", lines: [] }
  }

  // Reads, searches and the rest: their first line says enough.
  return { summary: first.length > 60 ? first.slice(0, 59) + "…" : first, lines: [] }
}
