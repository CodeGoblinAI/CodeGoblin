// Real, cheap check (about a tenth of a cent): the same short conversation sent twice to GLM 5.3 Flash
// and DeepSeek V4 Flash, to see that the second request reports cached input and is priced for it.
// Keys are read into this process's environment only and never printed. Run: bun test/user-pass/real-cache-check.ts
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
const store = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".local", "share", "codegoblin", "auth.json"), "utf8")) as Record<string, { type?: string; key?: string }>
for (const [id, name] of [["zai", "ZAI_API_KEY"], ["deepseek", "DEEPSEEK_API_KEY"]]) if (store[id]?.type === "api" && store[id]?.key) process.env[name] = store[id]!.key
process.env.CODEGOBLIN_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "cg-cache-check-"))
const root = fs.mkdtempSync(path.join(os.tmpdir(), "cg-cache-root-"))
const { PROVIDERS } = await import("../../src/core/providers")
const { apiKey } = await import("../../src/core/auth")
const { runAgent } = await import("../../src/core/agent")
const { systemPrompt } = await import("../../src/core/system-prompt")
const { priceOf, atPeak } = await import("../../src/core/context")
const only = process.argv[2]
for (const [id, model] of [["zai", "glm-5.3-flash"], ["deepseek", "deepseek-v4-flash"]] as const) {
  if (only && only !== id) continue
  const provider = PROVIDERS[id]!
  const entry = provider.models.find((m) => m.id === model)!
  if (!apiKey(id)) { console.log(`${id}: no key stored, skipped`); continue }
  for (const round of [1, 2]) {
    let input = 0, output = 0, cached = 0, text = ""
    try {
      for await (const event of runAgent({ provider, modelId: model, apiKey: apiKey(id) ?? "", root, maxTurns: 1, effort: "low", messages: [{ role: "system", content: systemPrompt("terminal") }, { role: "user", content: "Reply with the single word: ok" }] })) {
        if (event.type === "text") text += event.delta
        if (event.type === "spend") { input += event.input; output += event.output; cached += event.cached ?? 0 }
      }
    } catch (error) { text = "ERROR " + (error instanceof Error ? error.message : String(error)).slice(0, 400) }
    const full = priceOf({ input, output }, { input: entry.price!.input, output: entry.price!.output })
    const real = priceOf({ input, output, cached }, entry.price)
    console.log(`${id}/${model} request ${round}: ${input} in (${cached} cached) / ${output} out; priced $${real?.toFixed(6)} (was $${full?.toFixed(6)} with cache ignored)${atPeak(entry.price) ? " [peak hours]" : ""}; said: ${text.trim().slice(0, 300)}`)
  }
}
process.exit(0)
