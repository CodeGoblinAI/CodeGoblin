// Everyday file jobs on a real model, step by step: what it called, with what, how long each took, and whether
// the job was actually done. These are the "simple stuff" a person asks for - move this folder, rename these,
// tidy that - and where a model that reaches for the wrong tool, or the wrong shell's syntax, burns minutes.
//
// Costs a cent or two a task. The key is read into this process only and never printed.
//   bun test/user-pass/real-everyday-tasks.ts [provider/model] [task ...]     tasks: move rename sort delete find
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const target = process.argv[2] ?? "refuseless/deepseek-v4.1-flash-abliterated"
const wanted = process.argv.slice(3)
const providerId = target.slice(0, target.indexOf("/")), modelId = target.slice(target.indexOf("/") + 1)
const store = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".local", "share", "codegoblin", "auth.json"), "utf8")) as Record<string, { type?: string; key?: string }>
if (store[providerId]?.type !== "api" || !store[providerId]!.key) { console.log("no " + providerId + " key stored - skipped"); process.exit(0) }
const secret = store[providerId]!.key!
process.env.CODEGOBLIN_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "cg-tasks-profile-"))

const { resolveSelection, effortFor } = await import("../../src/core/providers")
const { runAgent } = await import("../../src/core/agent")
const { systemPrompt } = await import("../../src/core/system-prompt")
const { Permissions } = await import("../../src/core/permission")
const { costOf } = await import("../../src/core/context")
const selection = resolveSelection(target)
if (!selection) { console.log("no such model: " + target); process.exit(0) }

/** A folder of a person's files: names with spaces, an accent, a nested folder, a few sizes. */
function project(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cg tasks "))
  const put = (file: string, bytes = 40) => { fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.writeFileSync(path.join(root, file), "x".repeat(bytes)) }
  for (let n = 1; n <= 14; n++) put(`Holiday Photos/IMG_${String(n).padStart(4, "0")}.jpeg`, 200 + n)
  put("Holiday Photos/été à la plage.jpeg", 900)
  put("Holiday Photos/edited/final cut (2).jpeg", 5000)
  put("Holiday Photos/edited/notes.txt")
  for (const name of ["report final.pdf", "report draft.pdf", "budget 2025.xlsx", "song.mp3", "clip.mp4", "setup.exe", "readme.txt", "photo.png", "archive.zip", "todo list.txt"]) put("Downloads/" + name, 100)
  put("temp/cache/a.tmp"); put("temp/cache/b.tmp"); put("temp/old build.log", 3000)
  put("Projects/site/index.html"); put("Projects/site/big video.mov", 250_000); put("Projects/notes.md", 1200)
  return root
}
const exists = (root: string, file: string) => fs.existsSync(path.join(root, file))
const count = (root: string, dir: string, ext?: string): number => {
  try { return fs.readdirSync(path.join(root, dir), { recursive: true }).filter((name) => !ext || String(name).toLowerCase().endsWith(ext)).length } catch { return -1 }
}
const TASKS: Record<string, { ask: string; done: (root: string) => boolean }> = {
  move: { ask: "Move the Holiday Photos folder into Archive/2025.", done: (root) => !exists(root, "Holiday Photos") && exists(root, "Archive/2025/Holiday Photos/IMG_0001.jpeg") && exists(root, "Archive/2025/Holiday Photos/edited/final cut (2).jpeg") && exists(root, "Archive/2025/Holiday Photos/été à la plage.jpeg") },
  rename: { ask: "Rename every .jpeg file in Holiday Photos (including the edited folder) to .jpg.", done: (root) => count(root, "Holiday Photos", ".jpeg") === 0 && count(root, "Holiday Photos", ".jpg") === 16 },
  sort: { ask: "Sort the files in Downloads into subfolders by kind: Documents, Media, Programs and Other.", done: (root) => fs.readdirSync(path.join(root, "Downloads"), { withFileTypes: true }).every((entry) => entry.isDirectory()) && count(root, "Downloads") >= 12 },
  delete: { ask: "Delete the temp folder.", done: (root) => !exists(root, "temp") && exists(root, "Projects/notes.md") },
  find: { ask: "Which is the largest file in this folder, and how big is it?", done: () => true },
}

const summary: string[] = []
for (const name of wanted.length ? wanted : Object.keys(TASKS)) {
  const task = TASKS[name]
  if (!task) { console.log("no such task: " + name); continue }
  const root = project()
  console.log(`\n=== ${name}: "${task.ask}"`)
  const started = Date.now()
  const at = () => ((Date.now() - started) / 1000).toFixed(1).padStart(6) + "s  "
  let mark = started, calls = 0, steps = 0, failedCalls = 0, waiting = 0, toolTime = 0, dollars = 0, text = ""
  const begun = new Map<string, number>()
  const names: string[] = []
  const stop = new AbortController()
  const limit = setTimeout(() => stop.abort(), 6 * 60_000)
  try {
    for await (const event of runAgent({
      provider: selection.provider, modelId, apiKey: secret, root, maxTurns: 40, effort: effortFor(selection.model, "auto"), contextWindow: selection.model.contextWindow, signal: stop.signal,
      permissions: Permissions.withConfig(async () => "allow"),
      messages: [{ role: "system", content: systemPrompt("terminal") }, { role: "user", content: task.ask }],
    } as never)) {
      const e = event as { type: string; delta?: string; id?: string; name?: string; args?: string; result?: string; input?: number; output?: number; cached?: number; dollars?: number }
      if (e.type === "text") text += e.delta
      if (e.type === "tool_start") {
        if (mark) { waiting += Date.now() - mark; steps++; mark = 0 }
        calls++; names.push(e.name!); begun.set(e.id!, Date.now())
        console.log(at() + e.name + " " + (e.args ?? "").replace(/\s+/g, " ").slice(0, 150))
      }
      if (e.type === "tool_end") {
        const took = Date.now() - (begun.get(e.id!) ?? Date.now()); toolTime += took
        const result = (e.result ?? "").replace(/\s+/g, " ")
        const bad = /^(error|refused|stopped)|exit code [1-9]|is not recognized|not found|cannot find/i.test(result)
        if (bad) failedCalls++
        console.log(at() + "   -> " + (bad ? "FAILED " : "") + (took / 1000).toFixed(1) + "s  " + result.slice(0, 150))
        mark = Date.now()
      }
      if (e.type === "spend") dollars += costOf(e as never, selection.model.price) ?? 0
    }
  } catch (error) { console.log("ERROR " + (error instanceof Error ? error.message : String(error)).slice(0, 200)) }
  clearTimeout(limit)
  if (mark) waiting += Date.now() - mark
  const total = (Date.now() - started) / 1000
  const ok = task.done(root)
  const line = `${name.padEnd(7)} ${ok ? "DONE " : "NOT DONE"}  ${total.toFixed(0)}s, ${steps} model steps, ${calls} tool calls (${failedCalls} failed), model ${(waiting / 1000).toFixed(0)}s / tools ${(toolTime / 1000).toFixed(0)}s, $${dollars.toFixed(4)}  [${[...new Set(names)].join(", ")}]${stop.signal.aborted ? "  STOPPED AT 6 MINUTES" : ""}`
  console.log(line + "\n   said: " + text.replace(/\s+/g, " ").slice(-160))
  summary.push(line)
}
console.log("\n" + target + "\n" + summary.join("\n"))
process.exit(0)
