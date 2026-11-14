// User pass: idle compaction end to end, on a fake provider whose cache "lasts" a few seconds.
// The local test provider is given a price and a cache lifetime, and CODEGOBLIN_IDLE_AFTER_MS shortens the wait.
import fs from "node:fs"
import path from "node:path"
import { check, failed, fakeModel, tempDir, tui, web, delay } from "./harness.mjs"
const big = "x".repeat(4000)
let summaries = 0
const model = await fakeModel((sent) => {
  const last = String(sent.messages.at(-1)?.content ?? "")
  if (/Summarise the conversation so far/.test(last)) { summaries++; return { text: "SUMMARY: we talked at length about x.", usage: { prompt_tokens: 60000, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 59000 } } } }
  return { text: "noted", usage: { prompt_tokens: 1000, completion_tokens: 5 } }
})
const project = tempDir("cg-idle-project-")
// A saved conversation long enough to be worth compacting on the priced test model: ~70 turns of ~1,000 tokens.
function seed(profile) {
  const dir = path.join(profile, "state", "sessions"); fs.mkdirSync(dir, { recursive: true })
  const messages = [{ role: "system", content: "You are a goblin." }]
  for (let i = 0; i < 70; i++) messages.push({ role: i % 2 ? "assistant" : "user", content: "turn " + i + " " + big })
  const session = { id: "idleseed", title: "A long talk", created: Date.now(), updated: Date.now(), provider: "local", model: "fixture", messages, root: project }
  fs.writeFileSync(path.join(dir, "idleseed.json"), JSON.stringify(session))
}
// The local test provider gets a price and a three-second cache, so the arithmetic says yes and the timer is short.
const extraEnv = { CODEGOBLIN_LOCAL_PRICE: "4,20,0.4", CODEGOBLIN_LOCAL_CACHE_MINUTES: "30", CODEGOBLIN_LOCAL_CONTEXT: "1000000", CODEGOBLIN_IDLE_AFTER_MS: "3000" }

// --- Web ---
{
  const profile = tempDir("cg-idle-web-"); seed(profile)
  const w = await web({ model, cwd: project, profile, extraEnv })
  try {
    await w.page.locator(".row.session .label").first().click(); await w.page.waitForTimeout(1200)
    await w.fixture()
    await w.send("one more thing", 2500)
    const before = JSON.parse(fs.readFileSync(path.join(profile, "state", "sessions", "idleseed.json"), "utf8")).messages.length
    await delay(6000)
    const saved = JSON.parse(fs.readFileSync(path.join(profile, "state", "sessions", "idleseed.json"), "utf8"))
    check("web: left idle, the saved conversation is compacted to a summary and the recent part", saved.messages.length < before && /^Summary of earlier conversation:\nSUMMARY/.test(saved.messages[1]?.content ?? ""), before + " -> " + saved.messages.length + " messages; summaries " + summaries)
    check("web: what it replaced is in the archive, and its cost is counted with the cache price", fs.readdirSync(path.join(profile, "state", "sessions")).some((f) => /idleseed.*archive/.test(f)) && saved.spend?.cached >= 59000, fs.readdirSync(path.join(profile, "state", "sessions")).join(",") + " " + JSON.stringify(saved.spend))
    await w.page.reload(); await w.page.waitForTimeout(1200)
    await w.page.locator(".row.session .label").first().click(); await w.page.waitForTimeout(1500)
    const notes = (await w.page.locator(".tool.note").allInnerTexts()).join(" | ")
    check("web: opening it says it was compacted while idle and what that saves", /compacted while idle.*saves about \$\d+\.\d\d/.test(notes), notes.slice(0, 300))
    check("web: no console errors", w.errors.length === 0, w.errors.join(" | "))
  } catch (error) { check("web pass", false, error.message) } finally { await w.close() }
}

// --- TUI ---
{
  const profile = tempDir("cg-idle-tui-"); seed(profile)
  summaries = 0
  const t = await tui({ model, cwd: project, profile, extraEnv })
  try {
    t.write("/resume\r"); await delay(1200); t.write("\r"); await delay(1500)
    t.write("one more thing\r"); await t.until((s) => /noted/.test(s), 15000, "answer")
    t.clear()
    await t.until((s) => /compacted while idle/.test(s), 12000, "idle compaction note")
    check("TUI: left idle, it compacts and says what that saves", /saves about \$\d+\.\d\d on your next message/.test(t.screen()) && summaries === 1, "summaries " + summaries)
    t.clear(); t.write("typing a dra"); await delay(5500)
    check("TUI: it does not compact again, and not while a draft is in the box", summaries === 1, "summaries " + summaries)
  } catch (error) { check("TUI pass", false, error.message) } finally { t.kill() }
}
model.close()
console.log(failed() ? `\n${failed()} failed` : "\nall passed")
process.exit(0)
