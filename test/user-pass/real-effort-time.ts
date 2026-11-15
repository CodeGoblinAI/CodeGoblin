// Real, cheap measurement: how long one simple task takes at each reasoning effort (two or three tiny turns).
// The task is "read package.json and say the package name" - one tool call and a sentence.
// The key is read into this process's environment only and never printed.
// Run: bun test/user-pass/real-effort-time.ts [provider/model] [effort,effort,...]   ("auto" sends none)
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
const target = process.argv[2] ?? "deepseek/deepseek-v4-flash"
const levels = (process.argv[3] ?? "auto,max").split(",")
const providerId = target.slice(0, target.indexOf("/")), modelId = target.slice(target.indexOf("/") + 1)
const store = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".local", "share", "codegoblin", "auth.json"), "utf8")) as Record<string, { type?: string; key?: string }>
if (store[providerId]?.type !== "api" || !store[providerId]!.key) { console.log("no " + providerId + " key stored - skipped"); process.exit(0) }
const secret = store[providerId]!.key!
process.env.CODEGOBLIN_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "cg-effort-"))

const { resolveSelection, effortFor, effortLevels } = await import("../../src/core/providers")
const { runAgent } = await import("../../src/core/agent")
const { systemPrompt } = await import("../../src/core/system-prompt")
const { Permissions } = await import("../../src/core/permission")
const selection = resolveSelection(target)
if (!selection) { console.log("no such model: " + target); process.exit(0) }
console.log(target + " accepts: " + (effortLevels(selection.model).join(", ") || "no effort levels"))

for (const level of levels) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cg-effort-root-"))
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "walnut-" + Math.floor(Math.random() * 9000 + 1000), version: "1.0.0" }, null, 2))
  let text = "", input = 0, output = 0, firstText = 0, calls = 0
  const started = Date.now()
  try {
    for await (const event of runAgent({
      provider: selection.provider, modelId, apiKey: secret, root, maxTurns: 6, effort: effortFor(selection.model, level),
      permissions: Permissions.withConfig(async () => "allow"),
      messages: [{ role: "system", content: systemPrompt("terminal") }, { role: "user", content: "Read package.json and tell me the package name." }],
    } as never)) {
      const e = event as { type: string; delta?: string; input?: number; output?: number }
      if (e.type === "text") { text += e.delta; firstText ||= Date.now() - started }
      if (e.type === "tool_start") calls++
      if (e.type === "spend") { input += e.input ?? 0; output += e.output ?? 0 }
    }
  } catch (error) { text = "ERROR " + (error instanceof Error ? error.message : String(error)).slice(0, 200) }
  console.log(`effort ${level.padEnd(7)} ${((Date.now() - started) / 1000).toFixed(1).padStart(6)}s total, first words after ${(firstText / 1000).toFixed(1)}s, ${calls} tool call(s), ${input} in / ${output} out -> ${text.replace(/\s+/g, " ").slice(0, 90)}`)
}
process.exit(0)
