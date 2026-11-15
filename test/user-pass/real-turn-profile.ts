// Real, cheap measurement of where the time goes in one simple task (a few thousand tokens a step):
// a small project, "rename add to sum and update its callers", with the same instructions the app sends
// (system prompt + the index of your skills). Prints a timeline - for each step, how long the model took
// to say anything, how long it wrote for, and how long each tool ran - and the totals.
// The key is read into this process's environment only and never printed.
// Run: bun test/user-pass/real-turn-profile.ts [provider/model] [effort]
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
const target = process.argv[2] ?? "refuseless/deepseek-v4.1-flash-abliterated-fast"
const level = process.argv[3] ?? "auto"
const providerId = target.slice(0, target.indexOf("/")), modelId = target.slice(target.indexOf("/") + 1)
const store = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".local", "share", "codegoblin", "auth.json"), "utf8")) as Record<string, { type?: string; key?: string }>
if (store[providerId]?.type !== "api" || !store[providerId]!.key) { console.log("no " + providerId + " key stored - skipped"); process.exit(0) }
const secret = store[providerId]!.key!
process.env.CODEGOBLIN_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "cg-profile-"))

const root = fs.mkdtempSync(path.join(os.tmpdir(), "cg-profile-root-"))
fs.mkdirSync(path.join(root, "src")); fs.mkdirSync(path.join(root, "test"))
fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "walnut", version: "1.0.0", scripts: { test: "bun test" } }, null, 2))
fs.writeFileSync(path.join(root, "src", "math.js"), "export function add(a, b) {\n  return a + b\n}\n\nexport function double(n) {\n  return add(n, n)\n}\n")
fs.writeFileSync(path.join(root, "src", "cart.js"), "import { add } from \"./math.js\"\n\nexport function total(items) {\n  return items.reduce((sum, item) => add(sum, item.price), 0)\n}\n")
fs.writeFileSync(path.join(root, "src", "index.js"), "import { total } from \"./cart.js\"\nconsole.log(total([{ price: 2 }, { price: 3 }]))\n")
fs.writeFileSync(path.join(root, "test", "math.test.js"), "import { expect, test } from \"bun:test\"\nimport { add, double } from \"../src/math.js\"\ntest(\"add\", () => { expect(add(2, 3)).toBe(5) })\ntest(\"double\", () => { expect(double(4)).toBe(8) })\n")

const { resolveSelection, effortFor, refreshExperientialModels } = await import("../../src/core/providers")
if (providerId === "explabs") await refreshExperientialModels()
const { runAgent } = await import("../../src/core/agent")
const { systemPrompt } = await import("../../src/core/system-prompt")
const { Permissions } = await import("../../src/core/permission")
const { listSkills, skillIndex } = await import("../../src/core/skills")
const selection = resolveSelection(target)
if (!selection) { console.log("no such model: " + target); process.exit(0) }
const instructions = process.env.NO_SKILLS ? undefined : skillIndex(listSkills(root)) || undefined

const started = Date.now()
const at = () => ((Date.now() - started) / 1000).toFixed(1).padStart(6) + "s  "
let mark = started, phase = "", phaseStart = started, chars = 0
let waiting = 0, thinking = 0, writing = 0, tools = 0, steps = 0, input = 0, output = 0, cached = 0, text = ""
const toolStart = new Map<string, number>()
const close = () => {
  if (!phase) return
  const took = Date.now() - phaseStart
  if (phase === "thinking") thinking += took; else writing += took
  console.log(at() + "  " + phase + " for " + (took / 1000).toFixed(1) + "s (" + chars + " chars)")
  phase = ""; chars = 0
}
const open = (kind: string) => {
  if (phase === kind) return
  close()
  if (!phase && mark) { waiting += Date.now() - mark; console.log(at() + "model answered after " + ((Date.now() - mark) / 1000).toFixed(1) + "s of silence"); mark = 0; steps++ }
  phase = kind; phaseStart = Date.now()
}
try {
  for await (const event of runAgent({
    provider: selection.provider, modelId, apiKey: secret, root, maxTurns: 14, effort: effortFor(selection.model, level), instructions,
    contextWindow: selection.model.contextWindow,
    permissions: Permissions.withConfig(async () => "allow"),
    messages: [{ role: "system", content: systemPrompt("terminal") }, { role: "user", content: "Rename the function add to sum in src/math.js and update everything that uses it." }],
  } as never)) {
    const e = event as { type: string; delta?: string; id?: string; name?: string; args?: string; result?: string; input?: number; output?: number; cached?: number; reason?: string; waitMs?: number }
    if (e.type === "thinking") { open("thinking"); chars += e.delta?.length ?? 0 }
    if (e.type === "text") { open("writing"); chars += e.delta?.length ?? 0; text += e.delta }
    if (e.type === "tool_start") {
      if (mark) { waiting += Date.now() - mark; console.log(at() + "model answered after " + ((Date.now() - mark) / 1000).toFixed(1) + "s of silence"); mark = 0; steps++ }
      close(); toolStart.set(e.id!, Date.now())
      console.log(at() + "  tool " + e.name + " " + (e.args ?? "").replace(/\s+/g, " ").slice(0, 90))
    }
    if (e.type === "tool_end") {
      const took = Date.now() - (toolStart.get(e.id!) ?? Date.now()); tools += took
      console.log(at() + "  tool " + e.name + " done in " + (took / 1000).toFixed(1) + "s -> " + (e.result ?? "").replace(/\s+/g, " ").slice(0, 70))
      mark = Date.now()
    }
    if (e.type === "retry") console.log(at() + "  RETRY " + e.reason + ", waiting " + e.waitMs + "ms")
    if (e.type === "spend") { input += e.input ?? 0; output += e.output ?? 0; cached += e.cached ?? 0 }
  }
} catch (error) { console.log("ERROR " + (error instanceof Error ? error.message : String(error)).slice(0, 300)) }
close()
const total = Date.now() - started
const s = (ms: number) => (ms / 1000).toFixed(1) + "s"
console.log("\n" + target + " (effort " + level + ", " + (instructions ? "skill index " + instructions.length + " chars" : "no skill index") + ")")
console.log("total " + s(total) + " over " + steps + " model steps: waiting for the model to start " + s(waiting) + ", thinking " + s(thinking) + ", writing " + s(writing) + ", tools " + s(tools) + ", other " + s(total - waiting - thinking - writing - tools))
console.log(input + " in (" + cached + " cached) / " + output + " out -> " + text.replace(/\s+/g, " ").slice(-200))
const math = fs.readFileSync(path.join(root, "src", "math.js"), "utf8"), cart = fs.readFileSync(path.join(root, "src", "cart.js"), "utf8")
console.log("done right: " + (/function sum\(/.test(math) && !/\badd\(/.test(math) && /sum\(sum, item\.price\)|\bsum\(/.test(cart) && !/\badd\b/.test(cart)))
process.exit(0)
