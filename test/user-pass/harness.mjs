// Shared user-pass harness: a fake OpenAI-compatible model, the TUI in a PTY, the web app in headless Chromium.
// Every run uses a throwaway profile (CODEGOBLIN_DIR) and, by default, a throwaway project folder.
import http from "node:http"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"
import { createRequire } from "node:module"
const require = createRequire(import.meta.url)
const pty = require("C:/Users/shawn/code/CodeGoblin/node_modules/.bun/@lydell+node-pty@1.2.0-beta.10/node_modules/@lydell/node-pty/index.js")
const { chromium } = require("C:/Users/shawn/AppData/Local/npm-cache/_npx/e41f203b7505f1fb/node_modules/playwright")

export const delay = (ms) => new Promise((r) => setTimeout(r, ms))
// The Windows pseudo-console sends a run of blanks as "move the cursor right n", not as spaces.
// Those become spaces again here; dropped, columns ran together and boxes looked ragged.
export const plain = (text) => text
  .replace(/\x1b\[(\d*)C/g, (_, n) => " ".repeat(Number(n || 1)))
  .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "")
let failures = 0
export const check = (name, ok, detail = "") => {
  if (!ok) failures++
  console.log((ok ? "PASS " : "FAIL ") + name + (detail ? "\n     " + String(detail).replace(/\n/g, "\n     ") : ""))
}
export const failed = () => failures

export function tempDir(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)) }

/** A model that answers by `reply(sentBody, n)`: returns { text } or { tool: name, args } or { tools: [{name,args}] }. */
export async function fakeModel(reply, id = "fixture") {
  const seen = []
  const server = http.createServer((request, response) => {
    if (request.method === "GET") { response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ data: [{ id }] })); return }
    let body = ""
    request.on("data", (d) => body += d)
    request.on("end", async () => {
      const sent = JSON.parse(body)
      seen.push(sent)
      const answer = await reply(sent, seen.length)
      // A request that did not ask to stream (the summary call) gets one JSON body, as a real server gives.
      if (sent.stream === false) {
        response.writeHead(200, { "content-type": "application/json" })
        response.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: answer.text ?? "ok" } }], ...(answer.usage ? { usage: answer.usage } : {}) }))
        return
      }
      response.writeHead(200, { "content-type": "text/event-stream" })
      const tools = answer.tools ?? (answer.tool ? [{ name: answer.tool, args: answer.args }] : [])
      // { usage } is sent as the provider's usage block, on its own last chunk.
      const usage = answer.usage ? `data: ${JSON.stringify({ choices: [], usage: answer.usage })}\n\n` : ""
      if (tools.length) {
        const chunks = tools.map((t, index) => `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index, id: "c" + seen.length + "_" + index, function: { name: t.name, arguments: JSON.stringify(t.args ?? {}) } }] } }] })}\n\n`).join("")
        response.end(chunks + usage + "data: [DONE]\n\n")
      } else {
        response.end(`data: ${JSON.stringify({ choices: [{ delta: { content: answer.text ?? "ok" } }] })}\n\n${usage}data: [DONE]\n\n`)
      }
    })
  })
  await new Promise((r) => server.listen(0, "127.0.0.1", r))
  return { url: `http://127.0.0.1:${server.address().port}/v1`, seen, close: () => server.close() }
}

export function env(model, profile, extra = {}) {
  return { ...process.env, CODEGOBLIN_DIR: profile, CODEGOBLIN_LOCAL_URL: model.url, CODEGOBLIN_LOCAL_MODEL: "fixture", CODEGOBLIN_LOCAL_TOOLS: "1", ...extra }
}

export async function tui({ model, cwd, profile = tempDir("cg-pass-profile-"), cols = 140, rows = 42, extraEnv = {}, args = ["--model", "local"] }) {
  let out = ""
  const term = pty.spawn("bun.exe", [(process.env.CG_ROOT ?? "C:/Users/shawn/code/CG-Next") + "/src/tui/app.ts", ...args], { cwd, cols, rows, name: "xterm-256color", env: env(model, profile, extraEnv) })
  term.onData((d) => out += d)
  const api = {
    term, profile,
    get out() { return out },
    screen() { return plain(out) },
    clear() { out = "" },
    write(text) { term.write(text) },
    async until(pred, ms = 10000, label = "condition") {
      const end = Date.now() + ms
      while (!pred(plain(out))) { if (Date.now() > end) throw new Error("timed out: " + label + "\n--- screen tail ---\n" + plain(out).slice(-1500)); await delay(50) }
    },
    async type(text, wait = 600) { term.write(text); await delay(wait) },
    kill() { try { term.kill() } catch {} },
  }
  await api.until((s) => /ask the goblin/i.test(s), 25000, "startup")
  return api
}

export async function web({ model, cwd, profile = tempDir("cg-pass-web-"), extraEnv = {}, viewport = { width: 1280, height: 860 } }) {
  const server = spawn("bun", [(process.env.CG_ROOT ?? "C:/Users/shawn/code/CG-Next") + "/src/web/serve.ts"], { cwd, env: env(model, profile, extraEnv), windowsHide: true })
  let log = ""
  server.stderr.on("data", (d) => log += d)
  const url = await new Promise((resolve, reject) => { let t = ""; server.stdout.on("data", (d) => { t += d; const m = /http:\/\/localhost:(\d+)/.exec(t); if (m) resolve(m[0]) }); setTimeout(() => reject(new Error("web did not start: " + t + log)), 25000) })
  const browser = await chromium.launch({ executablePath: "C:/Users/shawn/AppData/Local/ms-playwright/chromium-1248/chrome-win64/chrome.exe", headless: true })
  const context = await browser.newContext({ viewport })
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: url })
  const page = await context.newPage()
  const errors = []
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()) })
  page.on("pageerror", (e) => errors.push(String(e)))
  await page.goto(url); await page.waitForTimeout(600)
  // The model list loads after the page; commands that name a model need it.
  await page.waitForFunction(() => {
    const label = document.querySelector("#provider-btn .picker-label")?.textContent ?? ""
    return label.trim() && !/loading/i.test(label)
  }, null, { timeout: 30000 }).catch(() => {})
  await page.waitForTimeout(300)
  const box = page.getByRole("textbox", { name: "Message or slash command" })
  const press = async (text, wait) => { await box.fill(text); await page.keyboard.press("Escape"); await page.keyboard.press("Enter"); await page.waitForTimeout(wait) }
  const current = () => page.evaluate(() => document.querySelector("#provider-btn .picker-label")?.textContent ?? "")
  // Switch to the fake model, retrying while the catalogue loads. Nothing is
  // ever sent to a real model by accident: send() refuses until this worked.
  const fixture = async () => {
    let onFixture = false
    for (let attempt = 0; attempt < 40 && !onFixture; attempt++) {
      await press("/model local/" + (extraEnv.CODEGOBLIN_LOCAL_MODEL ?? "fixture"), 300)
      onFixture = /fixture/i.test(await current())
      if (!onFixture) await page.waitForTimeout(500)
    }
    if (!onFixture) throw new Error("web: could not select local/fixture; label is " + (await current()))
  }
  await fixture()
  return {
    page, url, errors, profile, box, fixture,
    async send(text, wait = 900) {
      if (!text.startsWith("/") && !/fixture/i.test(await current())) throw new Error("refusing to send a prompt: the selected model is not the fixture (" + (await current()) + ")")
      await press(text, wait)
    },
    async note() { return ((await page.locator(".tool.note").allInnerTexts()).at(-1) ?? "").replace(/\s+/g, " ").trim() },
    async thread() { return (await page.locator("#thread").first().innerText().catch(async () => await page.locator("main").first().innerText())).replace(/\s+/g, " ") },
    async close() { await browser.close().catch(() => {}); server.kill() },
  }
}
