// User pass: models.dev providers in /connect and, once a key is stored, in the picker. Throwaway profile; fake key; no requests to providers.
import fs from "node:fs"
import path from "node:path"
import { check, failed, fakeModel, tempDir, tui, web, delay } from "./harness.mjs"

const model = await fakeModel(() => ({ text: "ok" }))
const project = tempDir("cg-catalog-project-")

// --- TUI ---
{
  const t = await tui({ model, cwd: project })
  try {
    await delay(6000) // the catalog download
    t.write("/connect gro"); await delay(800)
    check("TUI: /connect offers models.dev providers", /\/connect groq/.test(t.screen()) && /from models\.dev/.test(t.screen()), t.screen().split("\n").filter((l) => /groq/i.test(l)).slice(-2).join("\n"))
    t.write("\x15"); await delay(200)
    t.write("/connect groq\r"); await delay(800)
    t.write("gsk_not_a_real_key_000000000000\r"); await delay(1200)
    check("TUI: the key is stored in this profile", /connected groq/.test(t.screen()) && JSON.parse(fs.readFileSync(path.join(t.profile, "data", "auth.json"), "utf8")).groq?.key === "gsk_not_a_real_key_000000000000")
    t.clear(); t.write("/model groq"); await delay(800)
    const listed = t.screen().split("\n").filter((l) => /\/model groq\//.test(l))
    check("TUI: Groq's models join the picker at once", listed.length > 0, listed.slice(0, 3).join("\n"))
  } catch (error) { check("TUI pass", false, error.message) } finally { t.kill() }
}

// --- Web ---
{
  const w = await web({ model, cwd: project })
  try {
    await w.page.waitForTimeout(5000)
    await w.page.reload(); await w.page.waitForTimeout(1500); await w.fixture()
    await w.send("/connect ", 800)
    const items = (await w.page.locator(".palette > *").allInnerTexts()).join(" | ")
    check("web: /connect lists models.dev providers too", /from models\.dev/.test(items), items.slice(0, 200))
    const status = await w.page.evaluate(async () => (await fetch("/api/connect", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider: "openrouter", key: "sk-or-not-a-real-key-000000000000" }) })).json())
    check("web: connecting OpenRouter works", /connected openrouter/.test(status.message ?? ""), JSON.stringify(status))
    const providers = await w.page.evaluate(async () => (await (await fetch("/api/providers")).json()).providers.filter((p) => p.id.startsWith("openrouter/")).length)
    check("web: and its models are in the picker", providers > 10, String(providers))
    check("web: no console errors", w.errors.length === 0, w.errors.join(" | "))
  } catch (error) { check("web pass", false, error.message) } finally { await w.close() }
}
model.close()
console.log(failed() ? `\n${failed()} failed` : "\nall passed")
process.exit(0)
