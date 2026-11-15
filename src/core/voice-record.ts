import fs from "node:fs"
import path from "node:path"
import { Global } from "../platform/paths"

/**
 * The microphone, for the terminal app. (The web app records in the browser.)
 *
 * A terminal has no microphone, so something outside it does the recording:
 *
 * - Windows: a small PowerShell helper that stays running and drives the system's own recorder (winmm's
 *   MCI). Nothing to install. It is started ahead of time because PowerShell takes about a second to
 *   come up, and a second is the start of a sentence.
 * - Linux and macOS: `arecord` or sox's `rec`, if one is installed. Not tried on those systems yet.
 *
 * Either way the result is a 16 kHz mono 16-bit WAV, read into memory, and its file is removed.
 *
 * CG_VOICE_FAKE_WAV names a WAV that is returned instead of recording, so tests can run without a microphone.
 */
export type Recording = { stop: () => Promise<Uint8Array>; cancel: () => void }

const HELPER = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -Namespace CG -Name Mci -MemberDefinition '[DllImport("winmm.dll", CharSet = CharSet.Unicode)] public static extern int mciSendString(string command, System.Text.StringBuilder buffer, int size, System.IntPtr callback);'
function Mci([string]$command) {
  $code = [CG.Mci]::mciSendString($command, $null, 0, [System.IntPtr]::Zero)
  if ($code -ne 0) { throw "the recorder refused '$($command.Split(' ')[0])' (code $code)" }
}
[Console]::Out.WriteLine('ready')
while ($null -ne ($line = [Console]::In.ReadLine())) {
  try {
    if ($line -eq 'start') {
      Mci 'open new type waveaudio alias cgvoice'
      Mci 'set cgvoice bitspersample 16 channels 1 samplespersec 16000 bytespersec 32000 alignment 2'
      Mci 'record cgvoice'
      [Console]::Out.WriteLine('started')
    } elseif ($line.StartsWith('stop ')) {
      Mci 'stop cgvoice'
      Mci ('save cgvoice "' + $line.Substring(5) + '"')
      Mci 'close cgvoice'
      [Console]::Out.WriteLine('saved')
    } elseif ($line -eq 'cancel') {
      [void][CG.Mci]::mciSendString('close cgvoice', $null, 0, [System.IntPtr]::Zero)
      [Console]::Out.WriteLine('cancelled')
    }
  } catch {
    [void][CG.Mci]::mciSendString('close cgvoice', $null, 0, [System.IntPtr]::Zero)
    [Console]::Out.WriteLine('error ' + $_.Exception.Message)
  }
}
`

type Helper = { proc: ReturnType<typeof Bun.spawn>; ready: Promise<void>; next: () => Promise<string> }
let helper: Helper | undefined

function startHelper(): Helper {
  fs.mkdirSync(Global.Path.tmp, { recursive: true })
  const script = path.join(Global.Path.tmp, "voice-recorder.ps1")
  fs.writeFileSync(script, HELPER)
  const proc = Bun.spawn(["powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script], { stdin: "pipe", stdout: "pipe", stderr: "ignore", windowsHide: true })
  const lines: string[] = []
  const waiting: ((line: string) => void)[] = []
  let ended = false
  void (async () => {
    let buffer = ""
    const decoder = new TextDecoder()
    try {
      for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) {
        buffer += decoder.decode(chunk, { stream: true })
        for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
          const line = buffer.slice(0, end).trim()
          buffer = buffer.slice(end + 1)
          const taker = waiting.shift()
          if (taker) taker(line); else lines.push(line)
        }
      }
    } catch {}
    ended = true
    if (helper?.proc === proc) helper = undefined
    for (const taker of waiting.splice(0)) taker("error the recorder stopped")
  })()
  const next = () => new Promise<string>((resolve) => {
    const have = lines.shift()
    if (have !== undefined) resolve(have)
    else if (ended) resolve("error the recorder stopped")
    else waiting.push(resolve)
  })
  const ready = next().then((line) => { if (line !== "ready") throw new Error("the recorder did not start: " + line) })
  ready.catch(() => {})
  return { proc, ready, next }
}

const say = (to: Helper, line: string) => {
  const stdin = to.proc.stdin as { write: (text: string) => void; flush?: () => void }
  stdin.write(line + "\n")
  stdin.flush?.()
}

/** Whether this machine has a way to record at all. */
export function canRecord(): boolean {
  if (process.env.CG_VOICE_FAKE_WAV) return true
  if (process.platform === "win32") return true
  return Boolean(Bun.which("arecord") || Bun.which("rec"))
}

/** Starts whatever takes a moment to start, so the first recording begins at once. */
export function warmRecorder() {
  if (process.platform === "win32" && !process.env.CG_VOICE_FAKE_WAV) helper ??= startHelper()
}

export function stopRecorder() {
  const gone = helper
  helper = undefined
  try { gone?.proc.kill() } catch {}
}

const takeFile = (file: string): Uint8Array => {
  const bytes = new Uint8Array(fs.readFileSync(file))
  fs.rmSync(file, { force: true })
  return bytes
}

/** Begins recording from the default microphone. Resolves once it is really recording. */
export async function record(): Promise<Recording> {
  const fake = process.env.CG_VOICE_FAKE_WAV
  if (fake) return { stop: async () => new Uint8Array(fs.readFileSync(fake)), cancel: () => {} }

  fs.mkdirSync(Global.Path.tmp, { recursive: true })
  const file = path.join(Global.Path.tmp, "voice-" + process.pid + "-" + Date.now().toString(36) + ".wav")

  if (process.platform === "win32") {
    const using = (helper ??= startHelper())
    await using.ready
    say(using, "start")
    const started = await using.next()
    if (started !== "started") throw new Error(started.startsWith("error ") ? "Could not start recording: " + started.slice(6) + ". Is a microphone connected and allowed?" : "Could not start recording.")
    let over = false
    return {
      stop: async () => {
        if (over) throw new Error("the recording is already over")
        over = true
        say(using, "stop " + file)
        const saved = await using.next()
        if (saved !== "saved") throw new Error("Could not save the recording" + (saved.startsWith("error ") ? ": " + saved.slice(6) : "."))
        return takeFile(file)
      },
      cancel: () => { if (!over) { over = true; say(using, "cancel"); void using.next() } },
    }
  }

  const tool = Bun.which("arecord") ? ["arecord", "-q", "-f", "S16_LE", "-r", "16000", "-c", "1", "-t", "wav", file] : Bun.which("rec") ? ["rec", "-q", "-r", "16000", "-c", "1", "-b", "16", file] : undefined
  if (!tool) throw new Error("No recorder found: install arecord (alsa-utils) or sox to use voice input in the terminal.")
  const proc = Bun.spawn(tool, { stdin: "ignore", stdout: "ignore", stderr: "ignore" })
  let over = false
  return {
    stop: async () => {
      over = true
      proc.kill("SIGINT")
      await proc.exited
      return takeFile(file)
    },
    cancel: () => { if (!over) { over = true; proc.kill("SIGINT"); void proc.exited.then(() => fs.rmSync(file, { force: true })) } },
  }
}
