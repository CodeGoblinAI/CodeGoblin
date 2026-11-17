import { spawnSync } from "node:child_process"
import { spawn } from "./process"
import { workerCommand } from "./self"

/**
 * Nothing CG-Next starts outlives it - however it ends.
 *
 * Commands run with hidden consoles of their own on Windows, and process groups of their own elsewhere, so
 * closing the terminal window never reached them. Exit handlers cannot help when the app is killed outright,
 * which is how a closing terminal often ends it, and so do Task Manager and a crash. A dev server and a
 * command still running were both found alive after the window closed, invisible, one holding its port.
 *
 * So a small helper copy of the app is started beside it, outside the terminal. It is told each command's
 * process as it starts and ends, and it reads a pipe from the app; when the app ends, by any means, the pipe
 * closes, and the helper ends whatever commands are still running, with everything they started, and then
 * itself. It ends what a command is still running, as stopping a job does: a program a command opened and
 * let go of - an editor, a browser, `start notepad` - is not a command's any more and is left alone.
 */

/**
 * The helper, as the app sees it: started with the first command, never keeping the app from exiting, and
 * let go a minute after the last command ends - it is a whole copy of the runtime (about 54 MB), so it is
 * there while there is something to end and not otherwise. A turn's burst of commands shares one.
 * `null` when it could not be started, so starting is not tried before every command.
 */
let helper: { write: (line: string) => void; close: () => void } | null | undefined
const tracked = new Set<number>()
let idle: ReturnType<typeof setTimeout> | undefined
/** A minute; a test sets it shorter. */
const idleMs = () => Number(process.env.CG_REAPER_IDLE_MS) || 60_000

function reaper() {
  if (helper !== undefined) return helper
  helper = null
  try {
    const child = spawn(workerCommand("reaper", new URL("./reaper.ts", import.meta.url)), { detached: true, stdio: ["pipe", "ignore", "ignore"] })
    const lost = () => { if (helper === made) helper = undefined }
    child.on("error", () => { if (helper === made) helper = null })
    child.on("exit", lost)
    child.stdin?.on("error", lost)
    child.unref()
    // The pipe must not hold the app open either; what is written is still sent.
    ;(child.stdin as unknown as { unref?: () => void } | null)?.unref?.()
    const made = {
      write: (line: string) => { try { child.stdin?.write(line + "\n") } catch { lost() } },
      close: () => { try { child.stdin?.end() } catch {} },
    }
    helper = made
  } catch {
    helper = null
  }
  return helper
}

/** A command's process, to be ended if the app ends while it runs. */
export function endWithApp(pid: number | undefined): void {
  if (!pid) return
  const to = reaper()
  if (!to) return
  clearTimeout(idle)
  tracked.add(pid)
  to.write("+" + pid)
}

/** A command's process that has ended by itself, or been stopped: its number may be given to another. */
export function endedAlready(pid: number | undefined): void {
  if (!pid || !tracked.delete(pid) || !helper) return
  helper.write("-" + pid)
  if (tracked.size) return
  clearTimeout(idle)
  idle = setTimeout(() => {
    // With nothing to end, closing its pipe ends it; the next command starts another.
    if (tracked.size || !helper) return
    helper.close()
    helper = undefined
  }, idleMs())
  idle.unref?.()
}

/** Ends a process and everything it started. */
export function endTree(pid: number): void {
  try {
    if (process.platform === "win32") spawnSync("taskkill", ["/T", "/F", "/PID", String(pid)], { stdio: "ignore", windowsHide: true })
    else {
      // Commands are started in their own process group, so the group is everything they started.
      try { process.kill(-pid, "SIGKILL") } catch { process.kill(pid, "SIGKILL") }
    }
  } catch {}
}

/**
 * Ends each command's process tree.
 *
 * On Windows the app's own children are in a job that Windows ends with the app - but what they started is
 * let out of it. So by the time the pipe closes, the shell a command ran in is usually gone, and what it
 * started (the server, the watcher) is still running with the shell's number recorded as its parent; ending
 * the tree from the shell finds nothing. Those are found by that recorded number instead.
 */
function endTrees(pids: number[]): void {
  if (!pids.length) return
  if (process.platform !== "win32") { for (const pid of pids) endTree(pid); return }
  const table = processTable()
  for (const pid of pids) {
    if (table.some((entry) => entry.pid === pid)) endTree(pid)
    for (const entry of table) if (entry.parent === pid && entry.pid !== pid) endTree(entry.pid)
  }
}

/** Every process's number and its parent's, on Windows. Empty if it cannot be read. */
function processTable(): { pid: number; parent: number }[] {
  const listed = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Get-CimInstance Win32_Process | ForEach-Object { [string]$_.ProcessId + ' ' + [string]$_.ParentProcessId }"], { windowsHide: true, encoding: "utf8", timeout: 15_000 })
  return String(listed.stdout ?? "").split(/\r?\n/).map((line) => line.trim().split(" ").map(Number)).filter(([pid, parent]) => Number.isSafeInteger(pid) && Number.isSafeInteger(parent)).map(([pid, parent]) => ({ pid: pid!, parent: parent! }))
}

/** The helper itself: keeps the list, and when the app's end of the pipe closes, ends what is on it. */
export function serve(): void {
  const running = new Set<number>()
  let pending = ""
  let done = false
  const finish = () => {
    if (done) return
    done = true
    endTrees([...running])
    process.exit(0)
  }
  process.stdin.setEncoding("utf8")
  process.stdin.on("data", (chunk: string) => {
    pending += chunk
    for (let at = pending.indexOf("\n"); at >= 0; at = pending.indexOf("\n")) {
      const line = pending.slice(0, at).trim()
      pending = pending.slice(at + 1)
      const pid = Number(line.slice(1))
      if (!Number.isSafeInteger(pid) || pid <= 0) continue
      if (line[0] === "+") running.add(pid)
      else if (line[0] === "-") running.delete(pid)
    }
  })
  process.stdin.on("end", finish)
  process.stdin.on("close", finish)
  process.stdin.on("error", finish)
  process.stdin.resume()
}

if (import.meta.main) serve()
