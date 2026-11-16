// A real answer on a route that reports usage with every chunk (Refuseless deepseek-v4.1-flash-abliterated did
// on 2026-11-16) is counted once. Before the fix the app added every report: a 67-token prompt was counted as
// 1,206 and a turn showed $0.64 for a few cents of work.
//
// One short prompt, no tools: well under a cent. The key is read into this process only and never printed.
//   bun test/user-pass/real-usage-once.ts [model]
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const key = (JSON.parse(fs.readFileSync(path.join(os.homedir(), ".local", "share", "codegoblin", "auth.json"), "utf8")) as Record<string, { key?: string }>).refuseless?.key
if (!key) { console.log("no Refuseless key on this machine - skipped"); process.exit(0) }
process.env.CODEGOBLIN_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "cg-usage-once-"))
const { runAgent } = await import("../../src/core/agent")
const { PROVIDERS } = await import("../../src/core/providers")
const { costOf } = await import("../../src/core/context")

const modelId = process.argv[2] ?? "deepseek-v4.1-flash-abliterated"
const provider = PROVIDERS.refuseless!
const model = provider.models.find((each) => each.id === modelId)
if (!model) { console.log("no such model: " + modelId); process.exit(1) }

// What the provider itself says one request of this size uses, asked directly.
const direct = await fetch(provider.baseUrl!, {
  method: "POST", headers: { authorization: "Bearer " + key, "content-type": "application/json" },
  body: JSON.stringify({ model: modelId, stream: false, max_tokens: 150, messages: [{ role: "user", content: "Count from 1 to 30, one number per line." }] }),
}).then((response) => response.json() as Promise<{ usage?: { prompt_tokens?: number } }>)

let reports = 0, input = 0, output = 0, dollars = 0
for await (const event of runAgent({ provider, modelId, apiKey: key, messages: [{ role: "user", content: "Count from 1 to 30, one number per line. Do not use any tools." }], root: process.env.CODEGOBLIN_DIR, maxTurns: 1 })) {
  if (event.type !== "spend") continue
  reports++
  input += event.input; output += event.output
  dollars += costOf(event, model.price) ?? 0
}
console.log(JSON.stringify({ model: modelId, usageReportsCounted: reports, input, output, dollars: Number(dollars.toFixed(6)), aBarePromptAlone: direct.usage?.prompt_tokens }))
// The app's own prompt (instructions and tools) is a few thousand tokens. Counted once that is thousands;
// counted once per chunk it was hundreds of thousands.
const ok = input > 0 && input < 40_000 && output < 2_000 && dollars < 0.01
console.log(ok ? "PASS  one answer is counted once" : "FAIL  the answer was counted more than once")
process.exit(ok ? 0 : 1)
