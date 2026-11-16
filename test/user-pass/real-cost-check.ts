// Does the cost the app shows match what the provider actually charges?
//
// Refuseless reports the account's balance to six decimals (GET /v1/credits). For each model this reads the
// balance, runs one real, long agent turn - a couple of large files read in pieces, searched and summarised,
// around twenty steps and a million tokens, most of them cached - and reads the balance again. The difference
// is the bill. The app's own figure for the same turn is worked out exactly as the terminal and web apps do.
//
// This spends real money: about $0.05 to $0.30 a model. It stops a model's turn if the app's count passes
// CG_COST_CAP (default $0.60). Nothing else may be using the same key while it runs, or the balance moves
// for other reasons; the script waits for the balance to be still before and after, and says if it never was.
// The key is read into this process only and never printed.
//   bun test/user-pass/real-cost-check.ts [model ...]
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const key = (JSON.parse(fs.readFileSync(path.join(os.homedir(), ".local", "share", "codegoblin", "auth.json"), "utf8")) as Record<string, { key?: string }>).refuseless?.key
if (!key) { console.log("no Refuseless key on this machine - skipped"); process.exit(0) }
process.env.CODEGOBLIN_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "cg-cost-profile-"))
const repo = path.resolve(import.meta.dir, "..", "..")
const cap = Number(process.env.CG_COST_CAP ?? 0.6)

const { runAgent } = await import("../../src/core/agent")
const { PROVIDERS, effortFor } = await import("../../src/core/providers")
const { costOf } = await import("../../src/core/context")
const { systemPrompt } = await import("../../src/core/system-prompt")
const { Permissions } = await import("../../src/core/permission")
const provider = PROVIDERS.refuseless!
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

type Credits = { balance: number; reserved: number }
const credits = async (): Promise<Credits> => {
  const response = await fetch("https://api.refuseless.com/v1/credits", { headers: { authorization: "Bearer " + key }, signal: AbortSignal.timeout(20000) })
  if (!response.ok) throw new Error("credits: HTTP " + response.status)
  return await response.json() as Credits
}
/** The balance once nothing is in flight and two readings five seconds apart agree. */
async function settled(): Promise<{ balance: number; still: boolean }> {
  let last = await credits()
  for (let tries = 0; tries < 24; tries++) {
    await delay(5000)
    const now = await credits()
    if (now.reserved === 0 && last.reserved === 0 && now.balance === last.balance) return { balance: now.balance, still: true }
    last = now
  }
  return { balance: last.balance, still: false }
}

// What the provider says its prices are right now, beside the ones the app is using.
const live = await fetch("https://api.refuseless.com/v1/models", { headers: { authorization: "Bearer " + key } }).then((r) => r.json() as Promise<{ data?: { id: string; pricing?: Record<string, number> }[] }>).catch(() => ({ data: [] }))
const unauthenticated = await fetch("https://api.refuseless.com/v1/models").then((r) => r.status).catch(() => 0)
console.log("price list without a key: HTTP " + unauthenticated + (unauthenticated === 200 ? "" : "  <- the app's own refresh of this list sends no key"))

const models = process.argv.slice(2).length ? process.argv.slice(2) : ["deepseek-v4.1-flash-abliterated", "deepseek-v4.1-flash-abliterated-fast", "glm-5.3-flash-abliterated"]
const rows: Record<string, unknown>[] = []
for (const modelId of models) {
  const model = provider.models.find((each) => each.id === modelId)
  if (!model) { console.log("no such model: " + modelId); continue }
  const listed = live.data?.find((each) => each.id === modelId)?.pricing
  const pricesAgree = listed ? listed.input_per_m === model.price?.input && listed.output_per_m === model.price?.output && (listed.cached_input_per_m ?? undefined) === model.price?.cacheRead : undefined

  // A project with real, large files in it: enough to read that the turn runs long and the cache matters.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cg-cost-project-"))
  fs.mkdirSync(path.join(root, "src"))
  for (const name of ["core/agent.ts", "core/permission.ts", "web/serve.ts"]) fs.copyFileSync(path.join(repo, "src", name), path.join(root, "src", path.basename(name)))

  const before = await settled()
  const stop = new AbortController()
  let input = 0, output = 0, cached = 0, dollars = 0, steps = 0, reports = 0
  const started = Date.now()
  try {
    for await (const event of runAgent({
      provider, modelId, apiKey: key, root, maxTurns: 40, effort: effortFor(model, "auto"), contextWindow: model.contextWindow, signal: stop.signal,
      permissions: Permissions.withConfig(async () => "allow"),
      messages: [{ role: "system", content: systemPrompt("terminal") }, { role: "user", content: "This folder has three TypeScript files in src/. Work through them one at a time: read each file completely (in pieces of about 400 lines if needed), and use grep to find every exported function in it. Then write notes.md with, for each file, a two-sentence description and a list of its exported functions with the line each starts on. Do not skip any file and do not guess: read before you write." }],
    } as never)) {
      const e = event as { type: string; input?: number; output?: number; cached?: number; dollars?: number }
      if (e.type === "tool_start") steps++
      if (e.type !== "spend") continue
      reports++
      input += e.input ?? 0; output += e.output ?? 0; cached += e.cached ?? 0
      dollars += costOf(e as never, model.price) ?? 0
      if (dollars > cap) { console.log("  stopping " + modelId + ": the app's count passed $" + cap); stop.abort() }
    }
  } catch (error) {
    if (!stop.signal.aborted) console.log("  " + modelId + " ended with: " + String(error instanceof Error ? error.message : error).slice(0, 160))
  }
  const seconds = Math.round((Date.now() - started) / 1000)
  const after = await settled()
  const billed = Number((before.balance - after.balance).toFixed(6))
  const row = {
    model: modelId, steps, seconds, usageReports: reports,
    tokens: { input, cached, output }, appSays: Number(dollars.toFixed(6)), providerCharged: billed,
    appOverProvider: billed > 0 ? Number((dollars / billed).toFixed(3)) : null,
    balanceWasStill: before.still && after.still, appPricesMatchProviderList: pricesAgree, wroteNotes: fs.existsSync(path.join(root, "notes.md")),
  }
  rows.push(row)
  console.log(JSON.stringify(row))
}
console.log("")
let bad = 0
for (const row of rows as { model: string; appOverProvider: number | null; balanceWasStill: boolean }[]) {
  // Within 5%: rounding of sub-cent amounts and a price that moved by a cent per million are tolerable; a multiple is not.
  const ok = row.appOverProvider !== null && row.appOverProvider > 0.95 && row.appOverProvider < 1.05
  if (!ok) bad++
  console.log((ok ? "PASS  " : "FAIL  ") + row.model + ": the app showed " + (row.appOverProvider === null ? "a cost the provider did not charge" : (row.appOverProvider * 100).toFixed(1) + "% of what the provider charged") + (row.balanceWasStill ? "" : "  (the balance was moving - something else was using the key)"))
}
process.exit(bad ? 1 : 0)
