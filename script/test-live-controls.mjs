// Real Windows PTY regression test. Uses the fork's installed Node PTY binding.
import http from "node:http"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import assert from "node:assert/strict"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const require = createRequire(import.meta.url)
const pty = require(process.env.CODEGOBLIN_TEST_PTY ?? "C:/Users/shawn/code/CodeGoblin/node_modules/.bun/@lydell+node-pty@1.2.0-beta.10/node_modules/@lydell/node-pty/index.js")
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "cg-next-live-controls-"))
let requests = 0
let held
let output = ""
const server = http.createServer((request, response) => {
  if (request.method === "GET") {
    response.setHeader("content-type", "application/json")
    response.end(JSON.stringify({ data: [{ id: "fixture" }] }))
    return
  }
  let body = ""
  request.on("data", (data) => body += data)
  request.on("end", () => {
    assert.equal(request.headers.authorization, undefined)
    const sent = JSON.parse(body)
    assert.ok(sent.tools.length)
    requests++
    response.writeHead(200, { "content-type": "text/event-stream" })
    if (requests === 1) {
      response.end('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"live-test","function":{"name":"shell","arguments":"{\\"command\\":\\"echo live-control-ok\\"}"}}]}}]}\n\ndata: [DONE]\n\n')
    } else {
      if (requests <= 3) assert.ok(body.includes("live-control-ok"))
      response.write('data: {"choices":[{"delta":{"content":"Still working for the live-control test."}}]}\n\n')
      held = response
    }
  })
})
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
const term = pty.spawn("bun.exe", ["src/tui/app.ts", "--model", "local"], {
  cwd: root, cols: 140, rows: 40, name: "xterm-256color",
  env: { ...process.env, CODEGOBLIN_DIR: profile, CODEGOBLIN_LOCAL_URL: `http://127.0.0.1:${server.address().port}/v1`, CODEGOBLIN_LOCAL_MODEL: "fixture", CODEGOBLIN_LOCAL_TOOLS: "1" },
})
term.onData((data) => output += data)
let exited = false
term.onExit(() => exited = true)
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(predicate, label) {
  const deadline = Date.now() + 15000
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out: " + label + "\n" + output.slice(-3000))
    await delay(50)
  }
}
async function type(text) { term.write(text); await delay(150) }
try {
  await until(() => output.includes("ask the goblin"), "startup")
  await type("test live controls\r")
  await until(() => output.includes("Allow once"), "permission prompt")
  await type("/approvals")
  await type("\r")
  await until(() => output.includes("Full access"), "live approvals picker")
  // Pick Full access while the tool is waiting.
  await type("\x1b[B\x1b[B\r")
  await until(() => held !== undefined, "pending tool released and second request started")
  output = ""
  await type("\x1b[Z")
  await until(() => output.includes("Ask for approval"), "Shift-Tab during streaming")
  await type("/thinking\r")
  await until(() => /(?:hiding|showing) the model/.test(output), "slash command during streaming")
  await type("follow-up prompt\r")
  await type("UNSENT draft survives")
  held.end("data: [DONE]\n\n")
  await until(() => requests === 3, "queued follow-up starts")
  output = ""
  await type("\x1b[C")
  await until(() => output.includes("UNSENT draft survives"), "new draft survives queued prompt")
  await type("\x15")
  await type("/clear\r")
  await until(() => output.includes("queued - sending"), "session mutation queues")
  assert.equal(requests, 3)
  held.end("data: [DONE]\n\n")
  await until(() => output.includes("new conversation"), "queued clear after turn finishes")
  await type("test queued model\r")
  await until(() => requests === 4, "new conversation turn starts")
  await type("/model local/fixture\r")
  await type("UNSENT draft after model command")
  held.end("data: [DONE]\n\n")
  await until(() => output.includes("Local fixture"), "queued model command finishes")
  output = ""
  await type("\x1b[C")
  await until(() => output.includes("UNSENT draft after model command"), "new draft survives queued model command")
  assert.equal(requests, 4)
  await type("\x15")
  await type("test queued clear\r")
  await until(() => requests === 5, "clear regression turn starts")
  await type("/clear\r")
  await type("UNSENT draft after clear")
  output = ""
  held.end("data: [DONE]\n\n")
  await until(() => output.includes("new conversation"), "clear preserves a newer draft")
  assert.ok(output.includes("UNSENT draft after clear"))
  assert.equal(requests, 5)
  console.log("PASS: live approvals, pending release, Shift-Tab, slash control, queued prompt/model/clear draft preservation. Profile retained: " + profile)
} finally {
  term.write("\x03")
  await delay(1800)
  if (!exited) term.kill()
  server.closeAllConnections()
  server.close()
}
// The borrowed Windows PTY binding can retain a handle after onExit.
process.exit(0)
