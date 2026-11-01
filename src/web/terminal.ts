import { onPath } from "../core/formatter"
import { shellEnvironment } from "../core/tools"

/**
 * /terminal in the browser: a real shell in the project folder.
 *
 * The fork's web app has one. Bun 1.4's own pseudo-terminal runs the shell
 * (ConPTY on Windows), so nothing native is added; the page draws it with
 * xterm.js. What is typed here is the person's own, like a `!` command - the
 * model never sees or drives it.
 *
 * It is the most powerful thing the web server offers, so it is the hardest
 * to reach: a WebSocket on the loopback server that must carry this page's
 * own Origin (browsers always send one on a WebSocket, and a page elsewhere
 * cannot fake it), a few at a time, and the same scrubbed environment model
 * commands get - no variable that names a key, token or secret.
 */
export type TerminalSocket = {
  send(data: string): void
  close(code?: number, reason?: string): void
  data: { shell?: Bun.Subprocess; cwd: string; reserved?: boolean }
}

const MAX_TERMINALS = 4
let open = 0

/** The shell to start: PowerShell 7 if installed, else Windows PowerShell; $SHELL elsewhere. */
export function terminalShell(platform = process.platform, env = process.env): string[] {
  if (platform === "win32") return [onPath("pwsh", env) ?? "powershell.exe", "-NoLogo"]
  return [env.SHELL || "/bin/sh"]
}

export function canOpenTerminal(): boolean {
  return open < MAX_TERMINALS
}

/** Reserves a slot at upgrade time, so concurrent upgrades cannot pass the cap before open() fires. */
export function reserveTerminal(): boolean {
  if (open >= MAX_TERMINALS) return false
  open++
  return true
}

export function releaseTerminal(): void {
  open = Math.max(0, open - 1)
}

export function startTerminal(socket: TerminalSocket, cols = 100, rows = 30) {
  if (!socket.data.reserved) {
    if (!reserveTerminal()) {
      socket.send(JSON.stringify({ type: "output", data: "too many terminals open\r\n" }))
      socket.close(1013, "too many terminals")
      return
    }
    socket.data.reserved = true
  }
  const decoder = new TextDecoder()
  try {
    socket.data.shell = Bun.spawn(terminalShell(), {
      cwd: socket.data.cwd,
      env: { ...shellEnvironment(), TERM: "xterm-256color" },
      terminal: {
        cols: Math.max(20, Math.min(400, cols)),
        rows: Math.max(5, Math.min(200, rows)),
        data(_terminal: unknown, chunk: Uint8Array) {
          try { socket.send(JSON.stringify({ type: "output", data: decoder.decode(chunk, { stream: true }) })) } catch {}
        },
      },
    } as Parameters<typeof Bun.spawn>[1])
    void socket.data.shell.exited.then((code) => {
      try { socket.send(JSON.stringify({ type: "exit", code })) } catch {}
      try { socket.close(1000, "shell exited") } catch {}
    })
  } catch (error) {
    socket.data.reserved = false
    releaseTerminal()
    socket.send(JSON.stringify({ type: "output", data: "could not start a shell: " + (error instanceof Error ? error.message : String(error)) + "\r\n" }))
    socket.close(1011, "no shell")
  }
}

type Terminal = { write(data: string): void; resize(cols: number, rows: number): void }
const terminalOf = (socket: TerminalSocket) => (socket.data.shell as unknown as { terminal?: Terminal } | undefined)?.terminal

/** Keystrokes and window sizes from the page; anything else is ignored. */
export function terminalMessage(socket: TerminalSocket, raw: string | Buffer) {
  let message: { type?: unknown; data?: unknown; cols?: unknown; rows?: unknown }
  try { message = JSON.parse(String(raw)) } catch { return }
  const terminal = terminalOf(socket)
  if (!terminal) return
  if (message.type === "input" && typeof message.data === "string" && message.data.length <= 65_536) terminal.write(message.data)
  if (message.type === "resize" && typeof message.cols === "number" && typeof message.rows === "number") {
    terminal.resize(Math.max(20, Math.min(400, Math.round(message.cols))), Math.max(5, Math.min(200, Math.round(message.rows))))
  }
}

/** The page went away: the shell goes with it. */
export function endTerminal(socket: TerminalSocket) {
  if (!socket.data.shell && !socket.data.reserved) return
  socket.data.reserved = false
  releaseTerminal()
  try { socket.data.shell?.kill() } catch {}
  socket.data.shell = undefined
}
