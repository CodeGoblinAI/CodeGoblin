// The installed CodeGoblin fork (`cg`) in a real Windows Terminal window, to compare its UX with CG-Next.
//   node test/user-pass/fork-window.mjs [cols] [rows]
// Sandboxed: data, config, state, cache and the local runtime all live in a temp folder, so the real
// auth.json, sessions and runtime.json are never read or written. The only model is a fake one served
// here, so nothing reaches a real provider and nothing is spent; with it selected the fork never starts
// or probes its local runtime (port 8787). Prints TITLE and PID; drive it with real-terminal.ps1.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import http from "node:http"
import { execFileSync, spawn } from "node:child_process"
import { tempDir, delay } from "./harness.mjs"

const [cols = "120", rows = "36"] = process.argv.slice(2)
const exe = path.join(process.env.APPDATA ?? "", "npm", "node_modules", "@codegoblin-io", "codegoblin", "bin", "codegoblin.exe")
if (!fs.existsSync(exe)) throw new Error("the fork is not installed where expected: " + exe)

const reply = "Here is what I found.\n\n## Plan\n\n1. Read `src/core/agent.ts`\n2. Add the guard\n\n```ts\nexport function guard(n: number) {\n  return n > 0\n}\n```\n\n| File | Change |\n| --- | --- |\n| agent.ts | guard added |\n\nDone: **1 file** changed."
const textOf = (message) => typeof message?.content === "string" ? message.content : (message?.content ?? []).map((part) => part.text ?? "").join(" ")

/** What to answer, as the OpenAI chat API would: { text } or { tool, args }. Tool names come from the request. */
async function answer(body) {
  const tools = (body.tools ?? []).map((tool) => tool.function?.name ?? "")
  const pick = (...names) => tools.find((name) => names.includes(name))
  const last = body.messages.at(-1)
  if (!tools.length) return { text: "Add a guard to the agent loop" } // titles and summaries
  if (last?.role === "tool") return { text: reply }
  const said = textOf(body.messages.filter((m) => m.role === "user").at(-1))
  if (/slow/i.test(said)) await delay(9000)
  if (/question/i.test(said) && pick("question")) return { tool: "question", args: { questions: [{ question: "Which runtime should the script target?", header: "Runtime", options: [{ label: "Bun (Recommended)", description: "what the repo uses" }, { label: "Node", description: "the usual one" }, { label: "Deno", description: "the other one" }] }] } }
  if (/write|edit|change/i.test(said) && pick("write")) return { tool: "write", args: { filePath: "notes.md", content: "# Notes\n\n- a guard was added\n" } }
  const shell = pick("bash", "shell")
  if (/run|shell/i.test(said) && shell) return { tool: shell, args: { command: "git status", description: "Show the working tree status" } }
  return { tool: pick("glob") ?? tools[0], args: { pattern: "*.md" } }
}

let n = 0
const server = http.createServer((request, response) => {
  if (request.method === "GET") { response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ object: "list", data: [{ id: "fixture", object: "model" }] })); return }
  let raw = ""
  request.on("data", (d) => raw += d)
  request.on("end", async () => {
    const body = JSON.parse(raw)
    const got = await answer(body)
    const id = "chatcmpl-" + ++n, created = Math.floor(Date.now() / 1000), model = "fixture"
    const usage = { prompt_tokens: 4300, completion_tokens: 120, total_tokens: 4420, prompt_tokens_details: { cached_tokens: 4096 } }
    if (body.stream === false || body.stream === undefined) {
      response.setHeader("content-type", "application/json")
      response.end(JSON.stringify({ id, object: "chat.completion", created, model, choices: [{ index: 0, message: { role: "assistant", content: got.text ?? "" }, finish_reason: "stop" }], usage }))
      return
    }
    response.writeHead(200, { "content-type": "text/event-stream" })
    const chunk = (choice) => "data: " + JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [choice] }) + "\n\n"
    let out = chunk({ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null })
    if (got.tool) {
      out += chunk({ index: 0, delta: { tool_calls: [{ index: 0, id: "call_" + n, type: "function", function: { name: got.tool, arguments: JSON.stringify(got.args) } }] }, finish_reason: null })
      out += chunk({ index: 0, delta: {}, finish_reason: "tool_calls" })
    } else {
      for (const piece of got.text.match(/[\s\S]{1,40}/g) ?? [""]) out += chunk({ index: 0, delta: { content: piece }, finish_reason: null })
      out += chunk({ index: 0, delta: {}, finish_reason: "stop" })
    }
    out += "data: " + JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [], usage }) + "\n\n" + "data: [DONE]\n\n"
    response.end(out)
  })
})
await new Promise((r) => server.listen(0, "127.0.0.1", r))
const baseURL = `http://127.0.0.1:${server.address().port}/v1`

const sandbox = tempDir("cg-fork-sandbox-")
const dirs = Object.fromEntries(["data", "config", "state", "cache", "runtime"].map((name) => [name, path.join(sandbox, name)]))
for (const dir of Object.values(dirs)) fs.mkdirSync(dir, { recursive: true })
fs.mkdirSync(path.join(dirs.config, "codegoblin"), { recursive: true })
fs.writeFileSync(path.join(dirs.config, "codegoblin", "codegoblin.jsonc"), JSON.stringify({
  autoupdate: false,
  model: "fixture/fixture",
  // The local-runtime provider is the one that would talk to port 8787.
  disabled_providers: ["codegoblin"],
  provider: {
    fixture: {
      npm: "@ai-sdk/openai-compatible",
      name: "Fixture",
      options: { baseURL, apiKey: "not-a-real-key" },
      models: { fixture: { name: "Fixture", tool_call: true, limit: { context: 128000, output: 8000 } } },
    },
  },
}, null, 2))
const project = tempDir("cg-fork-project-")
fs.writeFileSync(path.join(project, "README.md"), "# demo\n")
try { execFileSync("git", ["init", "-q", "-b", "main", project]) } catch {}

const title = "CG-FORK-" + process.pid
const launcher = path.join(os.tmpdir(), "cg-fork-" + process.pid + ".cmd")
fs.writeFileSync(launcher, [
  "@echo off",
  "set XDG_DATA_HOME=" + dirs.data,
  "set XDG_CONFIG_HOME=" + dirs.config,
  "set XDG_STATE_HOME=" + dirs.state,
  "set XDG_CACHE_HOME=" + dirs.cache,
  "set CODEGOBLIN_RUNTIME_DIR=" + dirs.runtime,
  "set CODEGOBLIN_DISABLE_AUTOUPDATE=1",
  "set CLAUDE_CODE_MESSAGING_TOKEN=",
  "cd /d " + project,
  '"' + exe + '"',
].join("\r\n"))
spawn("wt.exe", ["-w", "new", "--size", cols + "," + rows, "new-tab", "--title", title, "--suppressApplicationTitle", "cmd.exe", "/c", launcher], { detached: true, stdio: "ignore" }).unref()
console.log("TITLE " + title)
// The fork's own process: the codegoblin.exe whose parent is the cmd running this launcher.
const launcherName = path.basename(launcher)
let pid = ""
for (let attempt = 0; attempt < 40 && !pid; attempt++) {
  await delay(500)
  try {
    pid = execFileSync("powershell", ["-NoProfile", "-Command", `$cmd = Get-CimInstance Win32_Process -Filter "Name='cmd.exe'" | Where-Object { $_.CommandLine -match '${launcherName}' } | Select-Object -First 1; if ($cmd) { (Get-CimInstance Win32_Process -Filter "Name='codegoblin.exe'" | Where-Object { $_.ParentProcessId -eq $cmd.ProcessId } | Select-Object -First 1).ProcessId }`], { encoding: "utf8" }).trim()
  } catch {}
}
console.log("PID " + pid)
console.log("SANDBOX " + sandbox)
process.on("SIGINT", () => process.exit(0))
