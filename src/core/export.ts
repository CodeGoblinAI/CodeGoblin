import fs from "node:fs/promises"
import path from "node:path"
import type { Session } from "./sessions"

/**
 * A conversation as a file someone can keep.
 *
 * Markdown rather than JSON: the point of exporting is to paste it into a
 * pull request, an issue, or a message to a colleague, and none of those
 * want a message array.
 */

const NEWLINE = String.fromCharCode(10)
const BLANK = NEWLINE + NEWLINE

/** A filename that survives every filesystem, from a title that need not. */
export function slug(title: string): string {
  const cleaned = [...title.toLowerCase()]
    .map((char) => (char >= "a" && char <= "z") || (char >= "0" && char <= "9") ? char : "-")
    .join("")
    .split("-")
    .filter(Boolean)
    .join("-")
  return cleaned.slice(0, 40) || "conversation"
}

export function toMarkdown(session: Session, when: number): string {
  const lines = [
    "# " + session.title,
    "",
    `*${new Date(when).toISOString().slice(0, 16).replace("T", " ")} · ${session.provider} · ${session.id}*`,
  ]

  for (const message of session.messages) {
    // The system prompt is the app talking to itself, not part of the record.
    if (message.role === "system") continue

    if (message.role === "user") {
      // The text as typed, so @mentions read as mentions rather than as the
      // files they pulled in.
      lines.push("", "## You", "", (message.display ?? message.content).trim())
      continue
    }

    if (message.role === "tool") {
      const result = message.content.trim()
      const shortened = result.length > 500 ? result.slice(0, 500) + NEWLINE + "…" : result
      lines.push("", "```", shortened, "```")
      continue
    }

    if (message.tool_calls?.length) {
      for (const call of message.tool_calls) {
        lines.push("", `**${call.function.name}** \`${call.function.arguments.slice(0, 200)}\``)
      }
    }
    if (message.content.trim()) lines.push("", "## Goblin", "", message.content.trim())
  }

  return lines.join(NEWLINE).replace(new RegExp(NEWLINE + "{3,}", "g"), BLANK) + NEWLINE
}

/** Writes beside the project, since an export nobody can find is not one. */
export async function exportSession(session: Session, root: string, when: number): Promise<string> {
  const name = `codegoblin-${slug(session.title)}.md`
  const target = path.join(root, name)
  await fs.writeFile(target, toMarkdown(session, when), "utf8")
  return name
}
