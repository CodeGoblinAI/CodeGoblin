/**
 * Claude Code marks the processes it launches so they know they are running
 * inside one of its sessions. When CodeGoblin is itself started from such a
 * process — an agent driving it, or simply opening CodeGoblin from a `claude`
 * terminal — that marker reaches the `claude` CLI we spawn for a native
 * session. Claude then renders a reduced startup UI, none of the readiness
 * markers `claude-session.ts` waits for ever appear, and every turn fails after
 * a 30s timeout with "Claude Code did not answer".
 *
 * Bisecting all fifteen inherited CLAUDE* variables against a real environment,
 * exactly one is responsible:
 *
 *   strip nothing                    never ready
 *   strip all CLAUDE*                ready in 3.0s
 *   keep CLAUDE_CODE_CHILD_SESSION   never ready
 *   keep any of the other fourteen   ready in 2.0-4.5s
 *
 * This is done once, to our own environment, rather than per spawn: the `#pty`
 * binding ignores the `env` option entirely and hands the child whatever the
 * parent has, so filtering at the call site is silently a no-op for exactly the
 * pty-backed sessions that need it. Verified with a control — a child asked to
 * print the variable reported it as set both with and without it in the `env`
 * passed to spawn.
 *
 * Only the child-session marker is removed. The session identifiers are left
 * alone: they are inert for the CLI, and the wider `CLAUDE_CODE_*` prefix
 * carries real user configuration such as `CLAUDE_CODE_MAX_OUTPUT_TOKENS` and
 * `CLAUDE_CODE_USE_BEDROCK` that must still reach it. CodeGoblin never reads
 * the marker itself, so dropping it costs nothing.
 */
const INHERITED_CHILD_MARKER = "CLAUDE_CODE_CHILD_SESSION"

export function stripInheritedSessionMarkers(env: NodeJS.ProcessEnv = process.env) {
  if (!(INHERITED_CHILD_MARKER in env)) return false
  delete env[INHERITED_CHILD_MARKER]
  return true
}

export const CLI_AGENT_INHERITED_MARKER = INHERITED_CHILD_MARKER
