import path from "node:path"
import { spawn } from "../platform/process"
import { killTree, shellEnvironment } from "./tools"

/**
 * Background jobs: commands that keep running while the agent carries on.
 *
 * The shell tool waits for its command and ends it after a timeout, which is right for a test run and wrong
 * for a dev server, a watcher or a long build: the model either lost thirty seconds and the server with it,
 * or could not start one at all. A job is started, answers at once with its first output, and is then read
 * (job_output) and ended (job_stop) by id.
 *
 * Jobs belong to this process and to the project folder they were started in. They end when CG-Next closes -
 * nothing is left running that nobody can see - and the person can list and stop them with /jobs.
 */

/** How much of a job's output is kept: the end of it, which is where a server says what is happening now. */
const KEEP = 400_000
/** A runaway loop of servers is a mistake, not a workload. */
export const MAX_RUNNING = 8
/** Finished jobs kept so their last output can still be read. */
const MAX_FINISHED = 20
/** How long a new job is watched before the tool answers: long enough to catch "command not found". */
const FIRST_LOOK_MS = 1500
const MAX_WAIT_MS = 120_000
const NEWLINE = String.fromCharCode(10)

type Job = {
  id: string
  command: string
  root: string
  startedAt: number
  endedAt?: number
  exitCode?: number | null
  /** Ended by job_stop, /jobs or the app closing, rather than by itself. */
  stopped?: boolean
  /** The kept end of the output; `total` counts every character there ever was. */
  output: string
  total: number
  /** How far the model has read, as a count from the very start. */
  seen: number
  /** Whether the model has been told this job ended. */
  told: boolean
  child: { pid?: number; kill: () => boolean }
  waiters: Set<() => void>
}

export type JobInfo = {
  id: string
  command: string
  running: boolean
  startedAt: number
  endedAt?: number
  exitCode?: number | null
  stopped: boolean
  lines: number
}

const jobs = new Map<string, Job>()
let counter = 0
let hooked = false

const sameRoot = (a: string, b: string) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
const running = (job: Job) => job.endedAt === undefined
const wake = (job: Job) => { for (const waiter of [...job.waiters]) waiter() }

function info(job: Job): JobInfo {
  return {
    id: job.id, command: job.command, running: running(job), startedAt: job.startedAt, stopped: job.stopped === true,
    ...(job.endedAt !== undefined ? { endedAt: job.endedAt, exitCode: job.exitCode ?? null } : {}),
    lines: job.output ? job.output.split(NEWLINE).length : 0,
  }
}

/** "3s", "4m 10s", "2h 5m". */
export function ago(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return seconds + "s"
  if (seconds < 3600) return Math.floor(seconds / 60) + "m" + (seconds % 60 ? " " + (seconds % 60) + "s" : "")
  return Math.floor(seconds / 3600) + "h" + (Math.floor((seconds % 3600) / 60) ? " " + Math.floor((seconds % 3600) / 60) + "m" : "")
}

function state(job: Job): string {
  if (running(job)) return "running for " + ago(Date.now() - job.startedAt)
  const how = job.stopped ? "stopped" : job.exitCode === 0 ? "finished, exit code 0" : "ended with exit code " + (job.exitCode ?? "unknown")
  return how + " after " + ago(job.endedAt! - job.startedAt)
}

/** Resolves when the job says something new, ends, the wait runs out or the turn is stopped. */
function wait(job: Job, ms: number, signal?: AbortSignal): Promise<void> {
  if (!running(job) || ms <= 0 || signal?.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer)
      job.waiters.delete(done)
      signal?.removeEventListener("abort", done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    job.waiters.add(done)
    signal?.addEventListener("abort", done, { once: true })
  })
}

/** What the model has not read yet, and marks it read. */
function unread(job: Job): string {
  const start = job.total - job.output.length
  const lost = Math.max(0, start - job.seen)
  const text = job.output.slice(Math.max(0, job.seen - start))
  job.seen = job.total
  return (lost ? `… ${lost} earlier characters were not kept …` + NEWLINE : "") + text
}

function forget() {
  const finished = [...jobs.values()].filter((job) => !running(job))
  for (const job of finished.slice(0, Math.max(0, finished.length - MAX_FINISHED))) jobs.delete(job.id)
}

/** Jobs of this project (all of them when no folder is given), oldest first. */
export function listJobs(root?: string): JobInfo[] {
  return [...jobs.values()].filter((job) => !root || sameRoot(job.root, root)).map(info)
}

export const runningJobs = (root?: string) => listJobs(root).filter((job) => job.running).length

/** The last lines of a job's output, for a person to look at. */
export function jobTail(id: string, lines = 40): string {
  const job = jobs.get(id)
  if (!job) return ""
  return job.output.replace(/\r\n?/g, NEWLINE).trimEnd().split(NEWLINE).slice(-lines).join(NEWLINE)
}

/**
 * Starts a command that keeps running. Answers after a first look, so a command that fails at once is seen
 * to fail here rather than three calls later.
 */
export async function startJob(command: string, root: string, options: { signal?: AbortSignal; firstLookMs?: number } = {}): Promise<string> {
  if (!command.trim()) return "error: empty command"
  if (options.signal?.aborted) return "stopped by the user before it ran"
  if (runningJobs() >= MAX_RUNNING) {
    return `error: ${MAX_RUNNING} background jobs are already running - job_output lists them; stop one with job_stop first`
  }
  if (!hooked) {
    hooked = true
    // Nothing started here outlives the app.
    process.on("exit", () => stopAllJobs())
  }

  const isWindows = process.platform === "win32"
  const argv = isWindows ? ["cmd.exe", "/d", "/s", "/c", command] : ["/bin/sh", "-c", command]
  const child = spawn(argv, { cwd: root, stdio: ["ignore", "pipe", "pipe"], env: shellEnvironment(), detached: !isWindows })
  const job: Job = { id: "job" + ++counter, command, root, startedAt: Date.now(), output: "", total: 0, seen: 0, told: false, child, waiters: new Set() }
  jobs.set(job.id, job)

  const take = (chunk: Buffer) => {
    const text = chunk.toString()
    job.total += text.length
    job.output += text
    if (job.output.length > KEEP * 1.5) job.output = job.output.slice(-KEEP)
    wake(job)
  }
  const end = (code: number | null) => {
    if (!running(job)) return
    job.endedAt = Date.now()
    job.exitCode = code
    wake(job)
    forget()
  }
  child.stdout?.on("data", take)
  child.stderr?.on("data", take)
  child.once("error", (error: Error) => { take(Buffer.from("error: " + error.message)); end(null) })
  child.once("close", (code: number | null) => end(code))

  // Until it ends or the look is over; output alone does not cut the look short, so a quick failure shows whole.
  const until = Date.now() + (options.firstLookMs ?? FIRST_LOOK_MS)
  while (running(job) && Date.now() < until && !options.signal?.aborted) await wait(job, until - Date.now(), options.signal)

  const first = unread(job).trim()
  if (!running(job)) {
    job.told = true
    return `${job.id} ended straight away (${state(job)}): ${command}` + NEWLINE + (first || "(no output)")
  }
  return (
    `started ${job.id} in the background: ${command}` + NEWLINE +
    (first ? first + NEWLINE : "(no output yet)" + NEWLINE) +
    `(still running. job_output with id "${job.id}" reads what it prints next - give it "until" to wait for a line such as the one a server prints when it is ready; job_stop ends it. It ends when CG-Next closes.)`
  )
}

/** What a job has printed since it was last read. With no id, the list of this project's jobs. */
export async function readJob(args: { id?: unknown; wait_ms?: unknown; until?: unknown }, root: string, signal?: AbortSignal): Promise<string> {
  const mine = [...jobs.values()].filter((job) => sameRoot(job.root, root))
  const id = typeof args.id === "string" ? args.id.trim() : ""
  if (!id) {
    if (!mine.length) return "no background jobs in this project (shell with background: true starts one)"
    for (const job of mine) if (!running(job)) job.told = true
    return mine.map((job) => `${job.id}  ${state(job)}  ${job.command}`).join(NEWLINE)
  }
  const job = mine.find((each) => each.id === id)
  if (!job) {
    const known = mine.map((each) => each.id).join(", ")
    return `error: no job called ${id} - ` + (known ? `this project has ${known}` : "this project has none; jobs end when CG-Next closes, so one from an earlier session is gone and has to be started again")
  }

  const needle = typeof args.until === "string" && args.until ? args.until.toLowerCase() : ""
  const asked = Number(args.wait_ms)
  const waitMs = Math.min(MAX_WAIT_MS, Number.isFinite(asked) && asked > 0 ? asked : needle ? 15_000 : 0)
  // Looked for in everything kept, not only what is unread: the line a model waits for has often been
  // handed to it already, in the answer that started the job.
  const found = () => !needle || job.output.toLowerCase().includes(needle)
  const deadline = Date.now() + waitMs
  const before = job.total
  // Waiting for a line: until it is there. Waiting without one: until anything new is there.
  while (running(job) && Date.now() < deadline && !signal?.aborted && (needle ? !found() : job.total === before)) {
    await wait(job, deadline - Date.now(), signal)
  }
  // A line rarely arrives alone; give the rest of it a moment.
  if (running(job) && job.total !== before && !signal?.aborted) await new Promise((resolve) => setTimeout(resolve, 150))

  const missed = !needle ? "" : found() ? ` - "${args.until}" is in its output` : ` - "${args.until}" has not appeared` + (running(job) ? " yet" : "")
  const text = unread(job).trimEnd()
  if (!running(job)) job.told = true
  return `${job.id}: ${state(job)}${missed}` + NEWLINE + (text || "(nothing new since it was last read)")
}

function endJob(job: Job) {
  if (!running(job)) return
  job.stopped = true
  killTree(job.child)
}

/**
 * Ends a job and everything it started. The answer starts with the job, not with "stopped": every surface
 * reads a result that starts with "stopped" as a call the person cut short.
 */
export async function stopJob(id: string, root?: string): Promise<string> {
  const job = jobs.get(id.trim())
  if (!job || (root && !sameRoot(job.root, root))) return `error: no job called ${id.trim() || "(nothing)"}`
  if (!running(job)) { job.told = true; return `${job.id} had already ended (${state(job)})` }
  endJob(job)
  const until = Date.now() + 3000
  while (running(job) && Date.now() < until) await wait(job, until - Date.now())
  if (running(job)) return `error: ${job.id} was told to stop and has not ended yet`
  job.told = true
  const last = unread(job).trim().split(NEWLINE).slice(-10).join(NEWLINE)
  return `${job.id} stopped: ${job.command}` + (last ? NEWLINE + last : "")
}

/** Ends every running job (of one project, or all). Returns how many. Safe in an exit handler. */
export function stopAllJobs(root?: string): number {
  let count = 0
  for (const job of jobs.values()) {
    if (!running(job) || (root && !sameRoot(job.root, root))) continue
    endJob(job)
    count++
  }
  return count
}

/**
 * Jobs that ended without the model being told, as a note for its next tool result. A server that died while
 * the model was editing files is something it has to hear about without asking.
 */
export function endedUntold(root: string): string {
  const ended = [...jobs.values()].filter((job) => sameRoot(job.root, root) && !running(job) && !job.told)
  for (const job of ended) job.told = true
  return ended.map((job) => `(background ${job.id} - ${job.command} - ${state(job)}. job_output with id "${job.id}" shows its last output.)`).join(NEWLINE)
}

/** Tests only: forget everything, ending what runs. */
export function resetJobs() {
  stopAllJobs()
  jobs.clear()
  counter = 0
}
