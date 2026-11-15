// The terminal app in a real Windows Terminal window, on a fake model and a throwaway profile, to look at.
//   node test/user-pass/tui-window.mjs [cols] [rows]
// Prints TITLE and, once the app is up, PID (the app's own process), then stays up serving the fake model.
// Take pictures and type with real-terminal.ps1:  shot <TITLE> out.png  /  keys <PID> "hello{ENTER}"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { execFileSync, spawn } from "node:child_process"
import { fakeModel, tempDir, delay } from "./harness.mjs"

const [cols = "120", rows = "36"] = process.argv.slice(2)
const reply = "Here is what I found.\n\n## Plan\n\n1. Read `src/core/agent.ts`\n2. Add the guard\n\n```ts\nexport function guard(n: number) {\n  return n > 0\n}\n```\n\n| File | Change |\n| --- | --- |\n| agent.ts | guard added |\n\nDone: **1 file** changed."
const model = await fakeModel(async (sent) => {
  const last = sent.messages.at(-1)
  const text = String(last?.content ?? "")
  if (last?.role === "tool") return { text: reply, usage: { prompt_tokens: 4300, completion_tokens: 120, prompt_tokens_details: { cached_tokens: 4096 } } }
  // "slow" in a prompt holds the answer back, to look at the working state and to stop or queue.
  if (/slow/i.test(text)) await delay(9000)
  // "testing" replies the way DeepSeek V4.1 Flash on Experiential Labs did: reasoning, answer, a sliver of reasoning, more answer.
  if (/testing/i.test(text)) return { stream: [{ reasoning: "The user is just testing." }, { text: "All" }, { reasoning: " " }, { text: " good on my end - tools, shell, and files are ready when you need them." }] }
  if (/question/i.test(text)) return { tool: "question", args: { question: "Which runtime should the script target?", options: [{ label: "Bun (Recommended)", description: "what the repo uses" }, { label: "Node" }, { label: "Deno" }] } }
  if (/write|edit|change/i.test(text)) return { tool: "write_file", args: { path: "notes.md", content: "# Notes\n\n- a guard was added\n" } }
  // "watch" runs a command that prints for a few seconds; "forever" one that outlives its (short) wait.
  if (/watch/i.test(text)) return { tool: "shell", args: { command: "bun slow.js --label=a-very-long-argument-that-goes-well-past-sixty-characters-in-total" } }
  if (/forever/i.test(text)) return { tool: "shell", args: { command: "bun forever.js", timeout_ms: 4000 } }
  if (/run|shell/i.test(text)) return { tool: "shell", args: { command: "git status" } }
  return { tool: "glob", args: { pattern: "*.md" }, usage: { prompt_tokens: 4200, completion_tokens: 30 } }
})
const project = tempDir("cg-window-project-")
fs.writeFileSync(path.join(project, "README.md"), "# demo\n")
fs.writeFileSync(path.join(project, "slow.js"), "let n = 0; const t = setInterval(() => { console.log('step ' + ++n + ' of 14'); if (n === 14) { clearInterval(t) } }, 600)")
fs.writeFileSync(path.join(project, "forever.js"), "let n = 0; setInterval(() => console.log('file ' + ++n + ' of 3000000000'), 300)")
try { execFileSync("git", ["init", "-q", "-b", "main", project]) } catch {}
const profile = tempDir("cg-window-profile-")
const title = "CGN-TEST-" + process.pid
// CG_THEME=paper starts on that theme; CG_SCHEME="One Half Light" gives the window a Windows Terminal colour scheme.
if (process.env.CG_THEME) { fs.mkdirSync(path.join(profile, "state"), { recursive: true }); fs.writeFileSync(path.join(profile, "state", "settings.json"), JSON.stringify({ theme: process.env.CG_THEME, appearance: process.env.CG_THEME === "paper" ? "light" : "dark" })) }
// Windows Terminal may already be running, in which case a new window does not inherit this process's
// environment - so the window runs a small launcher that sets it.
const launcher = path.join(os.tmpdir(), "cg-window-" + process.pid + ".cmd")
fs.writeFileSync(launcher, [
  "@echo off",
  "set CODEGOBLIN_DIR=" + profile,
  "set CODEGOBLIN_LOCAL_URL=" + model.url,
  "set CODEGOBLIN_LOCAL_MODEL=fixture",
  "set CODEGOBLIN_LOCAL_TOOLS=1",
  // Voice input: a speech model already on this machine, and optionally a recording in place of the microphone.
  ...["CG_VOICE_MODEL_DIR", "CG_VOICE_FAKE_WAV"].filter((name) => process.env[name]).map((name) => "set " + name + "=" + process.env[name]),
  "cd /d " + project,
  "bun C:\\Users\\shawn\\code\\CG-Next\\src\\tui\\app.ts --model local",
].join("\r\n"))
spawn("wt.exe", ["-w", "new", "--size", cols + "," + rows, "new-tab", "--title", title, "--suppressApplicationTitle", ...(process.env.CG_SCHEME ? ["--colorScheme", process.env.CG_SCHEME] : []), "cmd.exe", "/c", launcher], { detached: true, stdio: "ignore" }).unref()
console.log("TITLE " + title)
// The app's process: the bun started from this launcher's folder.
let pid = ""
for (let attempt = 0; attempt < 40 && !pid; attempt++) {
  await delay(500)
  try {
    pid = execFileSync("powershell", ["-NoProfile", "-Command", "(Get-CimInstance Win32_Process -Filter \"Name='bun.exe'\" | Where-Object { $_.CommandLine -match 'tui\\\\app.ts --model local' } | Sort-Object CreationDate | Select-Object -Last 1).ProcessId"], { encoding: "utf8" }).trim()
  } catch {}
}
console.log("PID " + pid)
console.log("PROJECT " + project)
process.on("SIGINT", () => process.exit(0))
