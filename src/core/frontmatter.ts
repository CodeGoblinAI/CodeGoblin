/**
 * The frontmatter at the top of a SKILL.md or a command file.
 *
 * Not a YAML parser, and deliberately forgiving: these files are written by
 * hand and by other tools, and plenty of them are not valid YAML - a colon in
 * an unquoted description is the usual one. What is handled is what the skill
 * store on this machine actually uses: `key: value`, quoted values, folded and
 * literal block scalars (`>-`, `|`), and booleans. Nested maps and lists are
 * skipped, because nothing here reads them.
 */
export type FrontmatterValue = string | boolean
export type Frontmatter = { data: Record<string, FrontmatterValue>; body: string }

const indented = (line: string) => line.length > 0 && (line[0] === " " || line[0] === "\t")

/** Folded: lines join with a space, and a blank line is a line break. */
function fold(lines: string[]): string {
  let out = ""
  let broke = true
  for (const line of lines) {
    if (!line.trim()) {
      out += "\n"
      broke = true
      continue
    }
    if (!broke) out += " "
    out += line.trim()
    broke = false
  }
  return out.trim()
}

function quoted(value: string): string {
  const quote = value[0]!
  const close = value.lastIndexOf(quote)
  const inner = close > 0 ? value.slice(1, close) : value.slice(1)
  if (quote === "'") return inner.split("''").join("'")
  try {
    return JSON.parse('"' + inner + '"') as string
  } catch {
    return inner
  }
}

export function parseFrontmatter(source: string): Frontmatter {
  const text = source.replace(/^﻿/, "").split("\r\n").join("\n")
  if (!text.startsWith("---\n")) return { data: {}, body: text }
  const lines = text.split("\n")
  let end = -1
  for (let index = 1; index < lines.length; index++) {
    if (lines[index] === "---" || lines[index] === "...") {
      end = index
      break
    }
  }
  if (end === -1) return { data: {}, body: text }

  const block = lines.slice(1, end)
  const data: Record<string, FrontmatterValue> = {}

  for (let index = 0; index < block.length; index++) {
    const line = block[index]!
    if (!line.trim() || line.trimStart().startsWith("#") || indented(line)) continue
    const match = /^([A-Za-z0-9_][A-Za-z0-9_.-]*)\s*:(?:\s+(.*))?$/.exec(line)
    if (!match) continue
    const key = match[1]!
    const rest = (match[2] ?? "").trim()

    // Everything indented under the key belongs to it, blank lines included
    // when more indented lines follow them.
    const following: string[] = []
    while (index + 1 < block.length) {
      const next = block[index + 1]!
      const blankThenMore = !next.trim() && index + 2 < block.length && indented(block[index + 2]!)
      if (!indented(next) && !blankThenMore) break
      following.push(next)
      index++
    }

    if (/^[>|][-+]?$/.test(rest)) {
      const depth = Math.min(...following.filter((each) => each.trim()).map((each) => each.length - each.trimStart().length))
      const body = following.map((each) => (each.trim() ? each.slice(Number.isFinite(depth) ? depth : 0) : ""))
      data[key] = rest[0] === "|" ? body.join("\n").trimEnd() : fold(body)
      continue
    }
    // A nested map or a list; nothing here reads those.
    if (!rest) continue

    const whole = [rest, ...following.map((each) => each.trim())].filter(Boolean).join(" ")
    if (rest.startsWith('"') || rest.startsWith("'")) {
      data[key] = quoted(whole)
      continue
    }
    const plain = whole.replace(/\s+#.*$/, "")
    data[key] = plain === "true" ? true : plain === "false" ? false : plain
  }

  return { data, body: lines.slice(end + 1).join("\n") }
}
