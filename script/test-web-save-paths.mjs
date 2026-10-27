// Real Web server regression: a fake local model drives the save paths that
// matter after a turn - a normal finish, Stop mid-stream, a provider failure
// after an approved write, and a follow-up on the stopped conversation. All
// state lives in a temp profile and workspace.
import http from "node:http"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import assert from "node:assert/strict"

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "cgn-savepaths-"))
const profile = path.join(scratch, "profile")
const work = path.join(scratch, "work")
fs.mkdirSync(work, { recursive: true })

let held = []
const model = http.createServer((req, res) => {
  if (req.method === "GET") { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ data: [{ id: "fixture" }] })); return }
  let body = ""
  req.on("data", (d) => (body += d))
  req.on("end", () => {
    const sent = JSON.parse(body)
    const lastUser = [...sent.messages].reverse().find((m) => m.role === "user")?.content ?? ""
    const sawTool = sent.messages.some((m) => m.role === "tool")
    const chunk = (delta) => "data: " + JSON.stringify({ choices: [{ delta }] }) + "\n\n"
    if (String(lastUser).includes("writefail")) {
      if (!sawTool) {
        res.writeHead(200, { "content-type": "text/event-stream" })
        res.end(chunk({ tool_calls: [{ index: 0, id: "w1", function: { name: "write_file", arguments: JSON.stringify({ path: "note.txt", content: "approved line\n" }) } }] }) + "data: [DONE]\n\n")
      } else {
        res.writeHead(500, { "content-type": "application/json" })
        res.end(JSON.stringify({ error: { message: "fixture provider failure" } }))
      }
      return
    }
    res.writeHead(200, { "content-type": "text/event-stream" })
    if (String(lastUser).includes("slow")) {
      res.write(chunk({ content: "partial words before stop" }))
      held.push(res)
      return
    }
    res.end(chunk({ content: "normal answer" }) + "data: [DONE]\n\n")
  })
})
await new Promise((r) => model.listen(0, "127.0.0.1", r))

const web = spawn("bun", [path.join(repo, "src/web/serve.ts")], {
  cwd: work,
  env: { ...process.env, CODEGOBLIN_DIR: profile, CODEGOBLIN_LOCAL_URL: `http://127.0.0.1:${model.address().port}/v1`, CODEGOBLIN_LOCAL_MODEL: "fixture", CODEGOBLIN_LOCAL_TOOLS: "1" },
  stdio: ["ignore", "pipe", "pipe"],
})
let log = ""
web.stdout.on("data", (d) => (log += d))
web.stderr.on("data", (d) => (log += d))
const delay = (ms) => new Promise((r) => setTimeout(r, ms))
let base
for (let i = 0; i < 100 && !base; i++) { await delay(100); base = log.match(/http:\/\/(?:localhost|127\.0\.0\.1):(\d+)/)?.[0] }
if (!base) { console.log("server did not start\n" + log); process.exit(1) }
const origin = { origin: base, "content-type": "application/json" }

async function chat(text, sessionId, onEvent) {
  const response = await fetch(base + "/api/chat", { method: "POST", headers: origin, body: JSON.stringify({ text, sessionId, provider: "local/fixture", mode: "full" }) })
  if (!response.ok) return { error: await response.text(), events: [] }
  const events = []
  const decoder = new TextDecoder()
  let buffer = ""
  for await (const part of response.body) {
    buffer += decoder.decode(part, { stream: true })
    let at
    while ((at = buffer.indexOf("\n\n")) >= 0) {
      const line = buffer.slice(0, at); buffer = buffer.slice(at + 2)
      if (!line.startsWith("data: ")) continue
      const event = JSON.parse(line.slice(6)); events.push(event); await onEvent?.(event)
    }
  }
  return { events }
}
const session = async (id) => (await fetch(base + "/api/session?id=" + id, { headers: origin })).json()
const types = (events) => events.map((e) => e.type).filter((t) => !["usage", "spend"].includes(t)).join(",")
const results = {}
let failed = false
try {
  // 1. Normal finish.
  const a = await chat("normal please")
  const aId = a.events.find((e) => e.type === "session")?.id
  const aS = await session(aId)
  results.normal = { events: types(a.events), stoppedMarkers: aS.session.messages.filter((m) => m.stopped).length, last: aS.session.messages.at(-1)?.content }

  // 2. Stop mid-stream.
  let bId
  const b = await chat("slow please", undefined, async (e) => {
    if (e.type === "session") bId = e.id
    if (e.type === "text" || e.type === "delta" || e.type === "content") {
      await fetch(base + "/api/stop", { method: "POST", headers: origin, body: JSON.stringify({ sessionId: bId }) })
    }
  })
  const bS = await session(bId)
  results.stop = {
    events: types(b.events),
    stoppedEvents: b.events.filter((e) => e.type === "stopped").length,
    stoppedMarkers: bS.session.messages.filter((m) => m.stopped).length,
    partialKept: bS.session.messages.some((m) => m.role === "assistant" && String(m.content).includes("partial words")),
    roles: bS.session.messages.map((m) => m.role + (m.stopped ? "*" : "")).join(" "),
  }

  // 3. Provider failure after an approved write.
  const c = await chat("writefail please")
  const cId = c.events.find((e) => e.type === "session")?.id
  const cS = await session(cId)
  const diff = await (await fetch(base + "/api/diff?sessionId=" + cId, { headers: origin })).json()
  results.writefail = {
    events: types(c.events),
    error: c.events.find((e) => e.type === "error")?.message,
    fileOnDisk: fs.existsSync(path.join(work, "note.txt")),
    savedReview: Boolean(cS.session.review),
    diffFiles: (diff.files || []).map((f) => f.path + " +" + f.added + " -" + f.removed),
    stoppedMarkers: cS.session.messages.filter((m) => m.stopped).length,
    openCalls: cS.session.messages.filter((m) => m.tool_calls?.length).length + " assistant tool-call msgs / " + cS.session.messages.filter((m) => m.role === "tool").length + " tool results",
  }
  // 4. Resume the stopped one: a follow-up still works.
  const d = await chat("normal again", bId)
  const dS = await session(bId)
  results.resumeAfterStop = { events: types(d.events), stoppedMarkers: dS.session.messages.filter((m) => m.stopped).length, count: dS.session.messages.length }
  assert.equal(results.normal.stoppedMarkers, 0)
  assert.equal(results.normal.last, "normal answer")
  assert.equal(results.stop.stoppedEvents, 1)
  assert.equal(results.stop.stoppedMarkers, 1)
  assert.ok(results.stop.partialKept, "partial answer kept after Stop")
  assert.ok(results.writefail.error, "provider failure reported")
  assert.ok(results.writefail.fileOnDisk && results.writefail.savedReview, "conversation and review saved after a failed turn")
  assert.deepEqual(results.writefail.diffFiles, ["note.txt +1 -0"])
  assert.equal(results.resumeAfterStop.stoppedMarkers, 1)
  console.log("PASS: normal save, one stopped marker with partial text, failed-turn save with diff, follow-up after stop")
} catch (error) {
  failed = true
  console.error(JSON.stringify(results, null, 1))
  console.error(error)
} finally {
  for (const r of held) try { r.end() } catch {}
  web.kill()
  model.close()
  setTimeout(() => process.exit(failed ? 1 : 0), 300)
}
