import fs from "fs"

/**
 * Last-resort terminal restore.
 *
 * The renderer puts the terminal into several persistent modes — kitty keyboard
 * protocol, mouse reporting, alternate screen, bracketed paste, hidden cursor.
 * Graceful exits unwind them, but anything that skips the normal teardown (a
 * SIGTERM, a killed parent, an abrupt crash) used to leave the shell in that
 * state: keystrokes echoing as escape sequences and every click emitting
 * coordinates, with no way back short of `reset`.
 *
 * Hooks only the paths the app does not already own. `exit` covers normal
 * termination and explicit process.exit; SIGTERM otherwise bypasses `exit`
 * entirely. SIGINT and SIGHUP are deliberately left alone — the TUI handles
 * ctrl+c itself (`exitOnCtrlC: false`) and context/exit.tsx owns SIGHUP, so
 * hooking them here would fight the existing handlers.
 */

// Order matters: leave the alternate screen last so the restored primary
// buffer is the one the user is looking at when the cursor reappears.
const SEQUENCES = [
  "\x1b[<u", // pop the kitty keyboard flags pushed at startup
  "\x1b[?1003l", // any-event mouse tracking off
  "\x1b[?1002l", // button-event tracking off
  "\x1b[?1000l", // basic mouse tracking off
  "\x1b[?1006l", // SGR extended coordinates off
  "\x1b[?1015l", // urxvt extended coordinates off
  "\x1b[?2004l", // bracketed paste off
  "\x1b[?25h", // show cursor
  "\x1b[?1049l", // leave alternate screen
].join("")

let installed = false
let restored = false

/** Idempotent: safe to call from several handlers racing each other. */
export function restoreTerminal() {
  if (restored) return
  restored = true
  if (!process.stdout.isTTY) return
  try {
    // writeSync, not stdout.write: this runs inside `exit` handlers where the
    // event loop is already gone and async writes would be dropped.
    fs.writeSync(1, SEQUENCES)
  } catch {
    // A closed or redirected fd is not worth surfacing while we are on the way out.
  }
}

export function installTerminalRestore() {
  if (installed) return
  installed = true

  process.on("exit", restoreTerminal)
  process.on("SIGTERM", () => {
    restoreTerminal()
    // 128 + SIGTERM, matching what the shell would have reported.
    process.exit(143)
  })
}

/** Test seam: lets a suite exercise install/restore more than once. */
export function resetTerminalRestoreForTests() {
  installed = false
  restored = false
}

export const TERMINAL_RESTORE_SEQUENCES = SEQUENCES
