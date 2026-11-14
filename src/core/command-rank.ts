import fs from "node:fs"
import path from "node:path"
import { Global } from "../platform/paths"

/**
 * Ranking the / list the way Claude Code does.
 *
 * It used to be "names that start with what you typed", commands first and
 * skills A to Z after them. So "/browser" found nothing named built-in-browser
 * or chrome-browser, and with dozens of skills the one you use every day was
 * a scroll away. Now every command and skill is scored against what was
 * typed - the whole name, the start of the name, a word inside it, anywhere
 * in it, its description, then the letters in order - and the ones you used
 * last come first among equals, or first of all when nothing is typed yet.
 *
 * The web page has a copy of commandScore and rankCommands in app.js; a test
 * checks the two order things the same way.
 */

/** How well `query` matches a command or skill; -1 when it does not. Higher is better. */
export function commandScore(value: string, hint: string, query: string): number {
  const q = query.toLowerCase().replace(/^\//, "")
  const name = value.toLowerCase().replace(/^\//, "")
  if (!q) return 1
  const short = Math.min(name.length, 99)
  if (name === q) return 1000
  if (name.startsWith(q)) return 900 - short
  if (name.split(/[-_:.\s/]+/).some((word) => word.startsWith(q))) return 700 - short
  if (name.includes(q)) return 600 - short
  const about = hint.toLowerCase()
  if (q.length >= 3 && about.split(/[^a-z0-9]+/).some((word) => word.startsWith(q))) return 300
  // The letters in order, with gaps: "cbr" finds chrome-browser. Fewer gaps, better.
  if (q.length >= 2) {
    let from = 0
    let last = -1
    let gaps = 0
    let found = true
    for (const char of q) {
      const at = name.indexOf(char, from)
      if (at < 0) { found = false; break }
      if (last >= 0) gaps += at - last - 1
      last = at
      from = at + 1
    }
    if (found) return 280 - Math.min(gaps * 5, 180)
  }
  if (q.length >= 4 && about.includes(q)) return 150
  return -1
}

/**
 * Items that match, best first. `recent` is newest first; a recent item gains
 * up to 60, so it rises within its kind of match but never above a closer one -
 * a skill you used a minute ago does not outrank the command whose name you typed.
 */
export function rankCommands<T extends { value: string; hint?: string }>(items: T[], query: string, recent: string[]): T[] {
  const bonus = (value: string) => {
    const at = recent.indexOf(value)
    return at < 0 ? 0 : 60 * (1 - at / Math.max(recent.length, 1))
  }
  return items
    .map((item, index) => ({ item, index, score: commandScore(item.value, item.hint ?? "", query) }))
    .filter((entry) => entry.score >= 0)
    .map((entry) => ({ ...entry, score: entry.score + bonus(entry.item.value) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => entry.item)
}

/** The commands and skills used last, newest first - kept by both surfaces, so each sees the other's. */
const RECENT_LIMIT = 30
const recentFile = () => path.join(Global.Path.state, "recent-commands.json")

export function loadRecentCommands(): string[] {
  try {
    const value: unknown = JSON.parse(fs.readFileSync(recentFile(), "utf8"))
    return Array.isArray(value) ? value.filter((each): each is string => typeof each === "string" && /^\/[^\s]{1,80}$/.test(each)).slice(0, RECENT_LIMIT) : []
  } catch {
    return []
  }
}

/** Records a use and returns the new list. A value that is not a /word is ignored. */
export function noteCommandUse(value: string): string[] {
  const current = loadRecentCommands()
  if (!/^\/[^\s]{1,80}$/.test(value)) return current
  const next = [value, ...current.filter((each) => each !== value)].slice(0, RECENT_LIMIT)
  try {
    fs.mkdirSync(path.dirname(recentFile()), { recursive: true })
    fs.writeFileSync(recentFile(), JSON.stringify(next))
  } catch {
    // A list that cannot be saved still orders this session.
  }
  return next
}
