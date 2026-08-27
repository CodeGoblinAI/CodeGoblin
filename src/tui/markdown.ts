import { theme, dim, bold, ansi } from "./ansi"

/**
 * Markdown for a terminal.
 *
 * Agents answer in markdown, so rendering it plainly makes every reply with a
 * code block look like noise. This covers what actually shows up in answers:
 * fenced code, inline code, bold, headings and list bullets.
 */
export function renderMarkdown(text: string, width: number): string[] {
  const out: string[] = []
  let inCode = false
  let codeLang = ""

  for (const raw of text.split(String.fromCharCode(10))) {
    const fence = raw.trimStart().startsWith("```")

    if (fence) {
      if (!inCode) {
        inCode = true
        codeLang = raw.trim().slice(3).trim()
        out.push(theme.border + "  ┌─ " + (codeLang || "code") + ansi.reset)
      } else {
        inCode = false
        out.push(theme.border + "  └" + "─".repeat(Math.max(2, Math.min(width, 40))) + ansi.reset)
      }
      continue
    }

    if (inCode) {
      // Code is shown verbatim; wrapping it would corrupt the meaning.
      for (const piece of hardWrap(raw, width - 4)) {
        out.push(theme.border + "  │ " + ansi.reset + theme.gold + piece + ansi.reset)
      }
      continue
    }

    if (!raw.trim()) { out.push(""); continue }

    const heading = /^(#{1,6})\s+(.*)$/.exec(raw)
    if (heading) {
      for (const piece of wrapWords(heading[2]!, width)) out.push(bold + theme.text + piece + ansi.reset)
      continue
    }

    const bullet = /^\s*[-*]\s+(.*)$/.exec(raw)
    if (bullet) {
      const pieces = wrapWords(bullet[1]!, width - 4)
      out.push(theme.goblin + "  • " + ansi.reset + inline(pieces[0] ?? ""))
      for (const piece of pieces.slice(1)) out.push("    " + inline(piece))
      continue
    }

    for (const piece of wrapWords(raw, width)) out.push(inline(piece))
  }

  return out
}

/** Inline code and bold, applied after wrapping so widths stay honest. */
function inline(text: string): string {
  let result = text.replace(/`([^`]+)`/g, (_, code) => theme.gold + code + ansi.reset + theme.text)
  result = result.replace(/\*\*([^*]+)\*\*/g, (_, strong) => bold + strong + ansi.reset + theme.text)
  return theme.text + result + ansi.reset
}

function wrapWords(text: string, width: number): string[] {
  if (width < 8) return [text]
  const lines: string[] = []
  let line = ""
  for (const word of text.split(" ")) {
    if (line && (line + " " + word).length > width) { lines.push(line); line = word }
    else line = line ? line + " " + word : word
  }
  if (line) lines.push(line)
  return lines.length ? lines : [""]
}

function hardWrap(text: string, width: number): string[] {
  if (width < 8 || text.length <= width) return [text]
  const lines: string[] = []
  for (let i = 0; i < text.length; i += width) lines.push(text.slice(i, i + width))
  return lines
}
