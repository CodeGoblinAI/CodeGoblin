import { expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import path from "node:path"

/**
 * Commands outlive nothing: when the app is killed outright - a closed terminal window, Task Manager, a crash -
 * the commands it was running end too. Before, a dev server and a waited-for command were found alive after
 * the window closed, invisible, one holding its port. What a command started and let go of is left alone.
 */
const windows = process.platform === "win32"

function running(mark: string): string[] {
  if (windows) {
    const listed = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -like '*${mark}*' } | ForEach-Object { [string]$_.ProcessId + ' ' + $_.CommandLine }`], { encoding: "utf8", windowsHide: true })
    return String(listed.stdout).split(/\r?\n/).filter(Boolean)
  }
  // The node processes themselves, not a shell that may still be wrapped round one.
  const listed = spawnSync("ps", ["-eo", "pid,args"], { encoding: "utf8" })
  return String(listed.stdout).split("\n").filter((line) => line.includes(mark) && /^\s*\d+\s+node\s/.test(line))
}
const which = (lines: string[], mark: string) => lines.map((line) => /-(job|waited|letgo)\b/.exec(line.slice(line.indexOf(mark)))?.[1]).filter(Boolean).sort()
const end = (lines: string[]) => { for (const line of lines) { const pid = Number(line.trim().split(" ")[0]); try { process.kill(pid, "SIGKILL") } catch {} } }

test("the helper that does it is there only while commands run", async () => {
  const { runForeground } = await import("../src/core/jobs")
  const helpers = () => {
    if (windows) {
      const listed = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `Get-CimInstance Win32_Process | Where-Object { $_.ParentProcessId -eq ${process.pid} -and $_.Name -ne 'powershell.exe' -and $_.CommandLine -like '*reaper*' } | ForEach-Object { $_.ProcessId }`], { encoding: "utf8", windowsHide: true })
      return String(listed.stdout).split(/\r?\n/).filter(Boolean).length
    }
    return String(spawnSync("ps", ["-eo", "pid,ppid,args"], { encoding: "utf8" }).stdout).split("\n").filter((line) => line.trim().split(/\s+/)[1] === String(process.pid) && line.includes("reaper")).length
  }
  process.env.CG_REAPER_IDLE_MS = "300"
  try {
    expect(await runForeground("echo one", process.cwd(), { timeoutMs: 10_000 })).toContain("one")
    expect(helpers()).toBe(1)
    await Bun.sleep(1500)
    expect(helpers()).toBe(0)
    // And the next command has one again.
    const next = runForeground(`node -e "setTimeout(()=>{},1500)"`, process.cwd(), { timeoutMs: 10_000 })
    await Bun.sleep(400)
    expect(helpers()).toBe(1)
    await next
  } finally {
    delete process.env.CG_REAPER_IDLE_MS
  }
}, 30_000)

test("when the app is killed outright, the commands it was running end with it", async () => {
  const mark = "cgreaper" + Date.now()
  const host = Bun.spawn([process.execPath, path.join(import.meta.dir, "fixtures", "reaper-host.ts"), mark], { stdout: "pipe", stderr: "ignore", windowsHide: true })
  try {
    const reader = host.stdout.getReader()
    let said = ""
    while (!said.includes("ready")) { const { value, done } = await reader.read(); if (done) break; said += new TextDecoder().decode(value) }
    expect(said).toContain("ready")
    expect(which(running(mark), mark)).toEqual(["job", "letgo", "waited"])

    // Outright: no exit handler runs.
    if (windows) spawnSync("taskkill", ["/F", "/PID", String(host.pid)], { stdio: "ignore", windowsHide: true })
    else process.kill(host.pid, "SIGKILL")

    let left = running(mark)
    for (let waited = 0; waited < 10_000 && which(left, mark).length > 1; waited += 500) { await Bun.sleep(500); left = running(mark) }
    expect(which(left, mark)).toEqual(["letgo"])
  } finally {
    end(running(mark))
    try { host.kill() } catch {}
  }
}, 40_000)
