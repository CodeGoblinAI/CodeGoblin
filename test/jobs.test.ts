import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { endedUntold, jobTail, listJobs, readJob, resetJobs, runningJobs, startJob, stopAllJobs, stopJob, MAX_RUNNING } from "../src/core/jobs"
import { runTool, shellWait, SHELL_WAIT_MAX_MS, SHELL_WAIT_MS, TOOL_SCHEMA } from "../src/core/tools"
import { Permissions } from "../src/core/permission"
import { runAgent } from "../src/core/agent"
import type { Provider } from "../src/core/providers"

const NL = String.fromCharCode(10)
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** A project with a server that says it is ready, then keeps printing; a script that fails; one that ends by itself. */
function project() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cg-jobs-"))
  fs.writeFileSync(path.join(root, "server.js"), "console.log('starting'); setTimeout(() => console.log('Ready on http://localhost:4000'), 400); let n = 0; setInterval(() => console.log('tick ' + ++n), 300)")
  fs.writeFileSync(path.join(root, "broken.js"), "console.error('Error: cannot find module left-pad'); process.exit(3)")
  fs.writeFileSync(path.join(root, "brief.js"), "console.log('built in 0.4s'); setTimeout(() => process.exit(0), 2200)")
  fs.writeFileSync(path.join(root, "pid.js"), "console.log('pid ' + process.pid); setInterval(() => {}, 1000)")
  return root
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }

// Job numbers are counted for the whole run, and another test file may have started one first.
beforeEach(() => resetJobs())
afterEach(() => resetJobs())

describe("background jobs", () => {
  test("a job answers at once with its first output, is read as it goes, and is stopped", async () => {
    const root = project()
    const began = Date.now()
    const started = await startJob("bun server.js", root)
    expect(Date.now() - began).toBeLessThan(4000)
    expect(started).toContain("started job1 in the background: bun server.js")
    expect(started).toContain("starting")
    expect(started).toContain("still running")
    expect(runningJobs(root)).toBe(1)

    await sleep(700)
    const more = await readJob({ id: "job1" }, root)
    expect(more).toContain("job1: running for")
    expect(more).toContain("tick")
    // Only what is new: the first line was already handed over.
    expect(more).not.toContain("starting")

    const stopped = await stopJob("job1", root)
    // Starts with the job, not with "stopped", which every surface reads as a call cut short.
    expect(stopped).toMatch(/^job1 stopped: bun server\.js/)
    expect(runningJobs(root)).toBe(0)
    expect(listJobs(root)[0]).toMatchObject({ id: "job1", running: false, stopped: true })
    expect(await stopJob("job1", root)).toContain("had already ended (stopped")
  }, 20_000)

  test("until waits for the line a server prints when it is ready", async () => {
    const root = project()
    fs.writeFileSync(path.join(root, "slow.js"), "setTimeout(() => console.log('Listening on port 4000'), 2500); setInterval(() => {}, 1000)")
    const started = await startJob("bun slow.js", root)
    expect(started).toContain("(no output yet)")
    const began = Date.now()
    const ready = await readJob({ id: "job1", until: "listening on" }, root)
    expect(ready).toContain("Listening on port 4000")
    expect(ready).toContain('"listening on" is in its output')
    // Asked again, it is still there: answered at once, with nothing new to show.
    const again = Date.now()
    expect(await readJob({ id: "job1", until: "listening on" }, root)).toContain('is in its output')
    expect(Date.now() - again).toBeLessThan(1000)
    expect(Date.now() - began).toBeLessThan(6000)
    const never = await readJob({ id: "job1", until: "compiled", wait_ms: 400 }, root)
    expect(never).toContain('"compiled" has not appeared yet')
    expect(never).toContain("nothing new")
  }, 20_000)

  test("a command that fails at once is seen to fail in the same answer", async () => {
    const root = project()
    const result = await startJob("bun broken.js", root)
    expect(result).toContain("job1 ended straight away (ended with exit code 3")
    expect(result).toContain("cannot find module left-pad")
    expect(runningJobs()).toBe(0)
    // Already said, so it is not said again.
    expect(endedUntold(root)).toBe("")
  }, 20_000)

  test("a job that ends on its own is reported once, to its own project", async () => {
    const root = project()
    expect(await startJob("bun brief.js", root)).toContain("started job1")
    expect(endedUntold(root)).toBe("")
    for (let i = 0; i < 60 && runningJobs(root); i++) await sleep(100)
    expect(endedUntold(project())).toBe("")
    const note = endedUntold(root)
    expect(note).toContain("background job1 - bun brief.js - finished, exit code 0")
    expect(endedUntold(root)).toBe("")
    expect(jobTail("job1")).toContain("built in 0.4s")
  }, 20_000)

  test("jobs are listed by project, and another project cannot read or stop them", async () => {
    const root = project()
    const other = project()
    await startJob("bun server.js", root, { firstLookMs: 200 })
    expect(await readJob({}, root)).toMatch(/^job1 {2}running for \d+s {2}bun server\.js$/)
    expect(await readJob({}, other)).toContain("no background jobs in this project")
    expect(await readJob({ id: "job1" }, other)).toContain("no job called job1")
    expect(await stopJob("job1", other)).toContain("no job called job1")
    expect(await readJob({ id: "job9" }, root)).toContain("this project has job1")
    expect(runningJobs(root)).toBe(1)
  }, 20_000)

  test("stopping ends the program the shell started, not only the shell", async () => {
    const root = project()
    const started = await startJob("bun pid.js", root)
    const pid = Number(/pid (\d+)/.exec(started)?.[1])
    expect(pid).toBeGreaterThan(0)
    expect(alive(pid)).toBe(true)
    expect(stopAllJobs(root)).toBe(1)
    for (let i = 0; i < 40 && alive(pid); i++) await sleep(100)
    expect(alive(pid)).toBe(false)
  }, 20_000)

  test("there is a limit to how many run at once", async () => {
    const root = project()
    for (let i = 0; i < MAX_RUNNING; i++) await startJob("bun pid.js", root, { firstLookMs: 0 })
    expect(runningJobs()).toBe(MAX_RUNNING)
    expect(await startJob("bun pid.js", root, { firstLookMs: 0 })).toContain(`${MAX_RUNNING} background jobs are already running`)
  }, 30_000)
})

describe("the job tools", () => {
  test("shell with background starts a job; the job tools read and stop it", async () => {
    const root = project()
    const started = await runTool("shell", { command: "bun server.js", background: true }, root)
    expect(started).toContain("started job1 in the background")
    // The ready line came with the start answer; waiting for it afterwards must not hang.
    expect(started).toContain("Ready on http://localhost:4000")
    expect(await runTool("job_output", { id: "job1", until: "ready on" }, root)).toContain('"ready on" is in its output')
    expect(await runTool("job_output", {}, root)).toContain("job1  running")
    expect(await runTool("job_stop", { id: "job1" }, root)).toMatch(/^job1 stopped: bun server\.js/)
  }, 20_000)

  test("they are offered, reading and stopping ask nothing, and starting asks like any command", async () => {
    const names = TOOL_SCHEMA.map((tool) => tool.function.name)
    expect(names).toContain("job_output")
    expect(names).toContain("job_stop")
    const asked: string[] = []
    const permissions = new Permissions(async (tool) => { asked.push(tool); return "reject" })
    expect((await permissions.decide("job_output", '{"id":"job1"}')).allowed).toBe(true)
    expect((await permissions.decide("job_stop", '{"id":"job1"}')).allowed).toBe(true)
    expect((await permissions.decide("shell", '{"command":"bun server.js","background":true}')).allowed).toBe(false)
    expect(asked).toEqual(["shell"])
  })

})

describe("a command that outlives its wait", () => {
  test("is not stopped: it carries on as a job, and the answer has its output so far and its id", async () => {
    const root = project()
    const began = Date.now()
    const result = await runTool("shell", { command: "bun server.js", timeout_ms: 1200 }, root)
    expect(Date.now() - began).toBeLessThan(6000)
    expect(result).toContain("starting")
    expect(result).toContain("Ready on http://localhost:4000")
    expect(result).toContain("still running after 1s")
    expect(result).toContain("carries on in the background as job1")
    expect(result).toContain('job_output with id "job1"')
    // Neither a failure nor a stop, as far as anything reading the first word is concerned.
    expect(/^(error|stopped)/.test(result)).toBe(false)
    expect(listJobs(root).map((job) => [job.id, job.running, job.command])).toEqual([["job1", true, "bun server.js"]])

    // What it had already printed was in the answer; reading the job gives only what came after.
    const next = await readJob({ id: "job1", wait_ms: 1500 }, root)
    expect(next).toContain("tick")
    expect(next).not.toContain("starting")
    expect(await runTool("job_stop", { id: "job1" }, root)).toContain("job1 stopped")
    expect(runningJobs()).toBe(0)
  }, 20_000)

  test("the process itself is the one that carries on, and stopping the job ends it", async () => {
    const root = project()
    const result = await runTool("shell", { command: "bun pid.js", timeout_ms: 900 }, root)
    const pid = Number(/pid (\d+)/.exec(result)?.[1])
    expect(pid).toBeGreaterThan(0)
    expect(alive(pid)).toBe(true)
    stopAllJobs()
    await sleep(600)
    expect(alive(pid)).toBe(false)
  }, 20_000)

  test("one that ends in time is answered as before, and is no job", async () => {
    const root = project()
    expect(await runTool("shell", { command: "bun broken.js", timeout_ms: 8000 }, root)).toBe("Error: cannot find module left-pad" + NL + "exit code 3")
    expect(listJobs(root)).toEqual([])
  }, 20_000)

  test("what it prints is passed on as it prints it, for a person to watch", async () => {
    const root = project()
    const seen: string[] = []
    const result = await runTool("shell", { command: "bun brief.js", timeout_ms: 9000 }, root, undefined, undefined, (text) => seen.push(text))
    expect(result).toContain("built in 0.4s")
    expect(seen.join("")).toContain("built in 0.4s")
  }, 20_000)

  test("stopping the turn ends a command that is being waited for", async () => {
    const root = project()
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 700)
    const result = await runTool("shell", { command: "bun pid.js", timeout_ms: 30_000 }, root, undefined, controller.signal)
    expect(result.startsWith("stopped by the user")).toBe(true)
    const pid = Number(/pid (\d+)/.exec(result)?.[1])
    await sleep(600)
    expect(alive(pid)).toBe(false)
    expect(listJobs(root)).toEqual([])
  }, 20_000)

  test("with every job slot taken it is ended, and says why", async () => {
    const root = project()
    for (let n = 0; n < MAX_RUNNING; n++) await startJob("bun pid.js", root, { firstLookMs: 50 })
    const result = await runTool("shell", { command: "bun pid.js", timeout_ms: 700 }, root)
    expect(result).toContain("ended after 1s")
    expect(result).toContain(MAX_RUNNING + " background jobs are already running")
    expect(runningJobs()).toBe(MAX_RUNNING)
  }, 30_000)

  test("the wait defaults to two minutes and is never more than ten, whatever is asked for", () => {
    expect(shellWait(undefined)).toBe(SHELL_WAIT_MS)
    expect(shellWait("soon")).toBe(SHELL_WAIT_MS)
    expect(shellWait(-5)).toBe(SHELL_WAIT_MS)
    expect(shellWait(1500)).toBe(1500)
    expect(shellWait(86_400_000)).toBe(SHELL_WAIT_MAX_MS)
    expect([SHELL_WAIT_MS, SHELL_WAIT_MAX_MS]).toEqual([120_000, 600_000])
  })
})

describe("the agent and its jobs", () => {
  const original = globalThis.fetch
  afterEach(() => { globalThis.fetch = original })
  const provider: Provider = { id: "test", label: "Test", baseUrl: "https://example.invalid/v1/chat/completions", models: [{ id: "m", label: "M", contextWindow: 128000 }] }
  const sse = (...chunks: unknown[]) => new Response(chunks.map((c) => "data: " + JSON.stringify(c)).join(NL + NL) + NL + NL + "data: [DONE]" + NL + NL, { headers: { "content-type": "text/event-stream" } })

  test("a job that died while the model was busy is said on its next tool result, once", async () => {
    const root = project()
    fs.writeFileSync(path.join(root, "dies.js"), "console.log('up'); setTimeout(() => { console.error('EADDRINUSE'); process.exit(1) }, 1900)")
    fs.writeFileSync(path.join(root, "a.txt"), "hello")
    const bodies: any[] = []
    const steps: [string, string][] = [["shell", '{"command":"bun dies.js","background":true}'], ["read_file", '{"path":"a.txt"}'], ["read_file", '{"path":"a.txt"}']]
    let step = 0
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)))
      // The job is given time to die before the model's second call is answered.
      if (step === 1) for (let i = 0; i < 80 && runningJobs(root); i++) await sleep(100)
      const next = steps[step++]
      return next ? sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c" + step, function: { name: next[0], arguments: next[1] } }] } }] }) : sse({ choices: [{ delta: { content: "done" } }] })
    }) as unknown as typeof fetch
    for await (const _ of runAgent({ provider, modelId: "m", apiKey: "k", messages: [{ role: "user", content: "go" }], root, maxTurns: 8 })) { /* drained */ }
    const results = bodies.at(-1).messages.filter((m: any) => m.role === "tool").map((m: any) => String(m.content))
    expect(results.length).toBe(3)
    expect(results[0]).toContain("started job1 in the background")
    expect(results[1]).toContain("hello")
    expect(results[1]).toContain("background job1 - bun dies.js - ended with exit code 1")
    expect(results[2]).not.toContain("background job1")
  }, 30_000)

  test("an agent limited to named tools gets the job tools with the shell, and not without it", async () => {
    const offered = async (tools: string[]) => {
      let body: any
      globalThis.fetch = (async (_url: string, init: RequestInit) => { body = JSON.parse(String(init.body)); return sse({ choices: [{ delta: { content: "ok" } }] }) }) as unknown as typeof fetch
      for await (const _ of runAgent({ provider, modelId: "m", apiKey: "k", messages: [{ role: "user", content: "go" }], root: process.cwd(), maxTurns: 1, tools })) { /* drained */ }
      return (body.tools ?? []).map((tool: any) => tool.function.name) as string[]
    }
    expect(await offered(["read_file", "shell"])).toEqual(expect.arrayContaining(["shell", "job_output", "job_stop"]))
    const reader = await offered(["read_file", "grep"])
    expect(reader).not.toContain("job_output")
    expect(reader).not.toContain("job_stop")
  })
})

describe("sending a waited-for command to the background, and hearing when a job ends", () => {
  const slow = process.platform === "win32" ? "ping -n 4 127.0.0.1 > nul & echo all done" : "sleep 3; echo all done"

  test("the wait ends at once, the command carries on as a job, and its end is announced", async () => {
    const { foregroundCommands, sendToBackground, onJobEnded, runForeground, listJobs } = await import("../src/core/jobs")
    const ended: string[] = []
    const off = onJobEnded((job) => ended.push(job.id + ":" + job.exitCode))
    const started = Date.now()
    const answer = runForeground(slow, process.cwd(), { timeoutMs: 60_000 })
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(foregroundCommands(process.cwd()).map((each) => each.command)).toEqual([slow])
    expect(sendToBackground(process.cwd())).toBe(1)
    const text = await answer
    expect(Date.now() - started).toBeLessThan(2500)
    expect(text).toContain("sent to the background by the user")
    expect(text).toMatch(/carries on in the background as job\d+/)
    expect(foregroundCommands(process.cwd())).toEqual([])
    const id = /as (job\d+)/.exec(text)![1]!
    expect(listJobs(process.cwd()).find((job) => job.id === id)?.running).toBe(true)
    // Nothing to send when nothing is being waited for.
    expect(sendToBackground(process.cwd())).toBe(0)
    for (let waitedMs = 0; waitedMs < 8000 && !ended.length; waitedMs += 100) await new Promise((resolve) => setTimeout(resolve, 100))
    expect(ended).toEqual([id + ":0"])
    off()
  }, 20_000)

  test("a job that is stopped is not announced as finished", async () => {
    const { onJobEnded, startJob, stopJob } = await import("../src/core/jobs")
    const ended: string[] = []
    const off = onJobEnded((job) => ended.push(job.id))
    const text = await startJob(slow, process.cwd(), { firstLookMs: 200 })
    const id = /job\d+/.exec(text)![0]
    await stopJob(id, process.cwd())
    await new Promise((resolve) => setTimeout(resolve, 600))
    expect(ended).toEqual([])
    off()
  }, 20_000)
})
