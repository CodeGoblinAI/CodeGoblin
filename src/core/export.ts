import fs from "node:fs/promises"
import path from "node:path"
import { loadArchive, type Session } from "./sessions"
import type { Message } from "./agent"
import { redactSecrets } from "./tools"
import { storedSecrets } from "./auth"

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

export function toMarkdown(session: Session, when: number, archived: Message[] = []): string {
  const lines = [
    "# " + session.title,
    "",
    `*${new Date(when).toISOString().slice(0, 16).replace("T", " ")} · ${session.provider} · ${session.id}*`,
  ]

  // Compaction replaced these in the live conversation; the record keeps them,
  // ahead of the summary that stood in for them.
  const messages = archived.length
    ? [...archived, { role: "user" as const, content: "--- compacted here: the conversation continued from a summary of the messages above ---" }, ...session.messages]
    : session.messages
  for (const message of messages) {
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
    if (message.stopped) lines.push("", "*stopped by the user*")
  }

  return lines.join(NEWLINE).replace(new RegExp(NEWLINE + "{3,}", "g"), BLANK) + NEWLINE
}

/**
 * Writes beside the project by default, since an export nobody can find is
 * not one, and wherever the user says otherwise.
 *
 * A given path is not confined to the working directory. Everywhere else a
 * path is checked, it came from the model; this one was typed by the person
 * asking for the file, and refusing to put their own export on their own
 * desktop would be protecting them from themselves.
 */
/**
 * The whole record - compacted messages too - with stored keys scrubbed, for
 * /export and /copy. A conversation saved before tool output was scrubbed can
 * still hold a key a model printed, and these are made to be pasted elsewhere.
 */
export async function sessionMarkdown(session: Session, when: number): Promise<string> {
  return redactSecrets(toMarkdown(session, when, await loadArchive(session.id).catch(() => [])), storedSecrets())
}

export async function exportSession(
  session: Session,
  root: string,
  when: number,
  target?: string,
): Promise<string> {
  const name = target?.trim() || `codegoblin-${slug(session.title)}.md`
  const absolute = path.resolve(root, name)
  await fs.mkdir(path.dirname(absolute), { recursive: true })
  await fs.writeFile(absolute, await sessionMarkdown(session, when), "utf8")
  return path.relative(root, absolute).startsWith("..") ? absolute : path.relative(root, absolute)
}
