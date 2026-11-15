// Real, cheap check that a model uses background jobs unprompted (a few thousand tokens on a cheap model):
// asked to start a dev server and say which port it listens on, it has to start it in the background - a
// foreground command would be killed at the timeout - read the port from the job's output, and leave it running.
// The port is random, so the answer cannot be guessed. The key is read into this process's environment only
// and never printed. Run: bun test/user-pass/real-jobs.ts [provider/model]
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
const target = process.argv[2] ?? "zai/glm-5.3-flash"
const providerId = target.slice(0, target.indexOf("/")), modelId = target.slice(target.indexOf("/") + 1)
const store = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".local", "share", "codegoblin", "auth.json"), "utf8")) as Record<string, { type?: string; key?: string }>
if (store[providerId]?.type !== "api" || !store[providerId]!.key) { console.log("no " + providerId + " key stored - skipped"); process.exit(0) }
const secret = store[providerId]!.key!
process.env.CODEGOBLIN_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "cg-realjobs-"))

const root = fs.mkdtempSync(path.join(os.tmpdir(), "cg-realjobs-root-"))
const port = 4100 + Math.floor(Math.random() * 800)
fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "demo", scripts: { dev: "bun server.js" } }, null, 2))
fs.writeFileSync(path.join(root, "server.js"), `console.log("compiling..."); setTimeout(() => console.log("Server listening on http://localhost:${port}"), 2500); setInterval(() => {}, 1000)`)

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
const started = Date.now()
try {
  for await (const event of runAgent({
    provider: selection.provider, modelId, apiKey: secret, root, maxTurns: 8,
    permissions: Permissions.withConfig(async () => "allow"),
    messages: [{ role: "system", content: systemPrompt("terminal") }, { role: "user", content: "Start this project's dev server and tell me which port it is listening on. Leave it running." }],
  } as never)) {
    const e = event as { type: string; delta?: string; name?: string; args?: string; input?: number; output?: number }
    if (e.type === "text") text += e.delta
    if (e.type === "tool_start") calls.push(e.name + " " + (e.args ?? "").replace(/\s+/g, " ").slice(0, 110))
    if (e.type === "spend") { input += e.input ?? 0; output += e.output ?? 0 }
  }
} catch (error) { text = "ERROR " + (error instanceof Error ? error.message : String(error)).slice(0, 300) }

const jobs = listJobs(root)
const checks: [string, boolean][] = [
  ["it started the server in the background", calls.some((call) => /^shell /.test(call) && /"background":\s*true/.test(call))],
  ["it named the right port", text.includes(String(port))],
  ["the server is still running afterwards", jobs.some((job) => job.running)],
]
for (const call of calls) console.log("  call: " + call)
for (const [label, ok] of checks) console.log((ok ? "PASS " : "FAIL ") + label)
console.log(`${target}: ${input} in / ${output} out, ${((Date.now() - started) / 1000).toFixed(1)}s -> ${text.replace(/\s+/g, " ").slice(0, 200)}`)
stopAllJobs()
process.exit(checks.every(([, ok]) => ok) ? 0 : 1)
