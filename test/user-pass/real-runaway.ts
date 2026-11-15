// Real, cheap check of what a model does with a command far bigger than it looked (a few thousand tokens):
// it is asked to run an indexer and report the count. The indexer says it has 2,800,000 files and gets
// through about 40 a second - nineteen hours. Nothing in the prompt warns of this. The shell tool stops
// waiting after its timeout and hands the command back as a background job with its output so far; what
// the model then does (stop it, estimate, keep waiting) is its own call, and this reports it.
// It must not: hold the turn for longer than a few waits, or claim a count it never saw.
// The key is read into this process's environment only and never printed.
// Run: bun test/user-pass/real-runaway.ts [provider/model]
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
const target = process.argv[2] ?? "zai/glm-5.3-flash"
const providerId = target.slice(0, target.indexOf("/")), modelId = target.slice(target.indexOf("/") + 1)
const store = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".local", "share", "codegoblin", "auth.json"), "utf8")) as Record<string, { type?: string; key?: string }>
if (store[providerId]?.type !== "api" || !store[providerId]!.key) { console.log("no " + providerId + " key stored - skipped"); process.exit(0) }
const secret = store[providerId]!.key!
process.env.CODEGOBLIN_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "cg-runaway-"))

const root = fs.mkdtempSync(path.join(os.tmpdir(), "cg-runaway-root-"))
fs.writeFileSync(path.join(root, "index-files.js"), `const total = 2800000; let done = 0; console.log("indexing " + total + " files under ./data ..."); setInterval(() => { done += 40; console.log("indexed " + done + " / " + total) }, 1000)`)

const { resolveSelection, refreshExperientialModels } = await import("../../src/core/providers")
if (providerId === "explabs") await refreshExperientialModels()
const { runAgent } = await import("../../src/core/agent")
const { systemPrompt } = await import("../../src/core/system-prompt")
const { Permissions } = await import("../../src/core/permission")
const { listJobs, stopAllJobs } = await import("../../src/core/jobs")
const selection = resolveSelection(target)
if (!selection) { console.log("no such model: " + target); process.exit(0) }

let text = "", input = 0, output = 0
const calls: string[] = []
const results: string[] = []
const started = Date.now()
const giveUp = new AbortController()
const limit = setTimeout(() => giveUp.abort(), 9 * 60_000)
try {
  for await (const event of runAgent({
    provider: selection.provider, modelId, apiKey: secret, root, maxTurns: 10, signal: giveUp.signal,
    permissions: Permissions.withConfig(async () => "allow"),
    messages: [{ role: "system", content: systemPrompt("terminal") }, { role: "user", content: "Run `bun index-files.js` and tell me how many files it indexed." }],
  } as never)) {
    const e = event as { type: string; delta?: string; name?: string; args?: string; result?: string; input?: number; output?: number }
    if (e.type === "text") text += e.delta
    if (e.type === "tool_start") calls.push(Math.round((Date.now() - started) / 1000) + "s  " + e.name + " " + (e.args ?? "").replace(/\s+/g, " ").slice(0, 110))
    if (e.type === "tool_end") results.push((e.result ?? "").split("\n").slice(-3).join(" | ").slice(0, 220))
    if (e.type === "spend") { input += e.input ?? 0; output += e.output ?? 0 }
  }
} catch (error) { text = "ERROR " + (error instanceof Error ? error.message : String(error)).slice(0, 300) }
clearTimeout(limit)

const seconds = (Date.now() - started) / 1000
const jobs = listJobs(root)
const checks: [string, boolean][] = [
  ["the turn ended by itself, well inside the nine minutes allowed", !giveUp.signal.aborted && seconds < 8 * 60],
  ["the command was handed back as a job rather than killed or waited on forever", results.some((result) => /carries on in the background as job\d+/.test(result))],
  ["it did not claim the indexing finished", !/\b2,?800,?000 files (were |have been )?indexed\b/i.test(text) || /would|estimate|still|hours|not finish|incomplete|so far/i.test(text)],
]
for (const [index, call] of calls.entries()) console.log("  call: " + call + "\n        -> " + (results[index] ?? ""))
for (const [label, ok] of checks) console.log((ok ? "PASS " : "FAIL ") + label)
console.log("what it did with the job: " + (jobs.length ? jobs.map((job) => job.id + (job.running ? " left running" : job.stopped ? " stopped by the model" : " ended")).join(", ") : "no job"))
console.log(`${target}: ${input} in / ${output} out, ${seconds.toFixed(0)}s -> ${text.replace(/\s+/g, " ").slice(0, 500)}`)
stopAllJobs()
process.exit(checks.every(([, ok]) => ok) ? 0 : 1)
