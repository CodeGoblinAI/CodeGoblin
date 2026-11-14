// Real, cheap check of Refuseless (well under a cent on deepseek-v4.1-flash-fast, $0.01 per million in):
// a plain answer with no effort sent, each effort level the catalog lists, a tool round trip (the model's
// reasoning is not sent back - does the API mind?), and whether usage comes back so the cost can be shown.
// The key is read into this process's environment only and never printed. Run: bun test/user-pass/real-refuseless.ts [model]
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
const store = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".local", "share", "codegoblin", "auth.json"), "utf8")) as Record<string, { type?: string; key?: string }>
if (store.refuseless?.type !== "api" || !store.refuseless.key) { console.log("no Refuseless key stored - skipped"); process.exit(0) }
process.env.REFUSELESS_API_KEY = store.refuseless.key
process.env.CODEGOBLIN_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "cg-refuseless-"))
const root = fs.mkdtempSync(path.join(os.tmpdir(), "cg-refuseless-root-"))
fs.writeFileSync(path.join(root, "README.md"), "# Zebra Tracker\n")
const { PROVIDERS, refreshRefuselessModels } = await import("../../src/core/providers")
const { apiKey } = await import("../../src/core/auth")
const { runAgent } = await import("../../src/core/agent")
const { systemPrompt } = await import("../../src/core/system-prompt")
const { priceOf } = await import("../../src/core/context")
const { Permissions } = await import("../../src/core/permission")

const before = PROVIDERS.refuseless!.models.length
const live = await refreshRefuselessModels()
console.log(`catalog: ${before} built in, ${live} after asking the live catalog (${live === before ? "same count - it may have refused, the built-in list stays" : "updated"})`)

const provider = PROVIDERS.refuseless!
const modelId = process.argv[2] ?? "deepseek-v4.1-flash-fast"
const model = provider.models.find((entry) => entry.id === modelId)!
let failed = 0
async function turn(label: string, prompt: string, effort?: string, maxTurns = 1) {
  let text = "", thought = "", input = 0, output = 0, cached = 0, tools: string[] = []
  try {
    for await (const event of runAgent({
      provider, modelId, apiKey: apiKey("refuseless") ?? "", root, maxTurns, ...(effort ? { effort } : {}),
      permissions: Permissions.withConfig(async () => "allow"),
      messages: [{ role: "system", content: systemPrompt("terminal") }, { role: "user", content: prompt }],
    } as never)) {
      const e = event as { type: string; delta?: string; name?: string; input?: number; output?: number; cached?: number }
      if (e.type === "text") text += e.delta
      if (e.type === "thinking" || e.type === "reasoning") thought += e.delta ?? ""
      if (e.type === "tool_start") tools.push(e.name ?? "?")
      if (e.type === "spend") { input += e.input ?? 0; output += e.output ?? 0; cached += e.cached ?? 0 }
    }
  } catch (error) { text = "ERROR " + (error instanceof Error ? error.message : String(error)).slice(0, 300) }
  const ok = !text.startsWith("ERROR") && text.trim().length > 0
  if (!ok) failed++
  const cost = priceOf({ input, output, cached }, model.price)
  console.log(`${ok ? "PASS" : "FAIL"} ${label}: ${input} in (${cached} cached) / ${output} out, $${cost?.toFixed(6) ?? "?"}${thought ? ", reasoning shown" : ""}${tools.length ? ", tools: " + tools.join(",") : ""}; said: ${text.trim().replace(/\s+/g, " ").slice(0, 120)}`)
  return { text, input, tools }
}

await turn("no effort sent", "Reply with the single word: ok")
for (const effort of model.efforts ?? []) await turn("effort " + effort, "Reply with the single word: ok", effort)
const rejected = await turn("effort medium (expected to be refused by the API)", "Reply with the single word: ok", "medium")
if (rejected.text.startsWith("ERROR")) failed-- // refusing it is the documented behaviour, and why the ladder leaves it out
const used = await turn("tool round trip", "Use the read_file tool on README.md, then answer with only the animal named in its title.", undefined, 4)
if (!used.tools.length || !/zebra/i.test(used.text)) { failed++; console.log("FAIL the tool was not used or the answer is wrong") }
if (!used.input) { failed++; console.log("FAIL no usage came back, so cost would read unknown") }
console.log(failed ? `\n${failed} failed` : "\nall passed")
process.exit(0)
