// User pass for the review fixes: one turn per conversation, Stop waits for the save, then a resend works.
import { check, failed, fakeModel, tempDir, web, delay } from "./harness.mjs"
let calls = 0
const model = await fakeModel(async (sent) => {
  calls++
  const user = String(sent.messages.filter((m) => m.role === "user").at(-1)?.content ?? "")
  if (/slow/.test(user)) await delay(4000)
  return { text: "answered: " + user }
})
const w = await web({ model, cwd: tempDir("cg-lock-project-") })
try {
  await w.send("first quick one", 1500)
  const id = await w.page.evaluate(() => sessionId)
  check("a conversation exists", typeof id === "string" && id.length > 0, String(id))
  // A slow turn, then a second request for the same conversation while it runs.
  await w.send("slow one please", 600)
  const second = await w.page.evaluate(async (sid) => {
    const r = await fetch("/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "overlap", sessionId: sid, provider: "local/fixture" }) })
    return { status: r.status, body: await r.json().catch(() => ({})) }
  }, id)
  check("a second turn on the same conversation is refused with 409", second.status === 409 && /still running/.test(second.body.error ?? ""), JSON.stringify(second))
  // Stop it, then send straight away.
  const stopped = await w.page.evaluate(async (sid) => (await fetch("/api/stop", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId: sid }) })).json(), id)
  check("Stop answers once the turn has let go", stopped.ok === true, JSON.stringify(stopped))
  await w.page.waitForTimeout(500)
  await w.send("right after the stop", 2000)
  const thread = await w.thread()
  check("a message sent right after Stop runs normally", /answered: right after the stop/.test(thread), thread.slice(-200))
  const saved = await w.page.evaluate(async (sid) => (await (await fetch("/api/session?id=" + sid)).json()).session.messages.filter((m) => m.role === "user").map((m) => m.content), id)
  check("the saved conversation has every prompt once, in order", JSON.stringify(saved) === JSON.stringify(["first quick one", "slow one please", "right after the stop"]), JSON.stringify(saved))
  check("no console errors", w.errors.filter((e) => !/409/.test(e)).length === 0, w.errors.join(" | "))
} catch (error) { check("web pass", false, error.message) } finally { await w.close() }
model.close()
console.log(failed() ? `\n${failed()} failed` : "\nall passed")
process.exit(0)
