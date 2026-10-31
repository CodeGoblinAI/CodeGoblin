import { runTool, redactSecrets } from "./tools"
import { storedSecrets } from "./auth"
import type { Permissions } from "./permission"
import type { Message } from "./agent"

/**
 * `!command` in the composer: run it yourself, no model in between.
 *
 * The fork's shell mode. The output is kept in the conversation as a message
 * from you, so the next prompt can say "fix that" and the model knows what
 * "that" is - and it is labelled as something you ran, never something the
 * model did. Nothing is asked first (you typed it), but deny rules still apply.
 */
export function typedCommand(text: string): string | undefined {
  const match = /^!\s*([\s\S]+)$/.exec(text.trim())
  return match?.[1]?.trim() || undefined
}

/** Longer than a tool's 30 s: a person runs builds and test suites this way. */
const TYPED_TIMEOUT_MS = 120_000
const DISPLAY_LINES = 40

export type TypedRun = { command: string; output: string; refused?: string; message?: Message }

export async function runTypedCommand(command: string, root: string, permissions: Permissions, signal?: AbortSignal): Promise<TypedRun> {
  const verdict = permissions.typedCommandVerdict(command)
  if (!verdict.allowed) return { command, output: verdict.reason, refused: verdict.reason }
  // Scrubbed like a model's tool output: this text is sent to the model and saved with the session.
  const output = redactSecrets(await runTool("shell", { command, timeout_ms: TYPED_TIMEOUT_MS }, root, undefined, signal), storedSecrets())
  const lines = output.split("\n")
  const shown = lines.length > DISPLAY_LINES ? [...lines.slice(0, DISPLAY_LINES), `... ${lines.length - DISPLAY_LINES} more lines`].join("\n") : output
  return {
    command,
    output,
    message: {
      role: "user",
      content: "I ran this command myself in the project directory (you did not run it):\n$ " + command + "\n```\n" + output + "\n```",
      display: "! " + command + "\n\n" + shown,
      typed: true,
    },
  }
}
