import { expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { runTypedCommand, typedCommand } from "../src/core/user-shell"
import { Permissions } from "../src/core/permission"
import { runAgent } from "../src/core/agent"

const workspace = () => fs.mkdtempSync(path.join(process.env.CODEGOBLIN_TEST_SANDBOX!, "typed-"))
const neverAsk = (rules: Record<string, "allow" | "ask" | "deny"> = {}) => new Permissions(async () => { throw new Error("a typed command must never ask") }, () => rules)

test("only a leading ! with something after it is a typed command", () => {
  expect(typedCommand("!git status")).toBe("git status")
  expect(typedCommand("  ! echo hi  ")).toBe("echo hi")
  expect(typedCommand("!")).toBeUndefined()
  expect(typedCommand("say !hi")).toBeUndefined()
  expect(typedCommand("/help")).toBeUndefined()
})

test("runs without asking, and the output is kept as something the person ran", async () => {
  const run = await runTypedCommand("echo typed-command-output", workspace(), neverAsk())
  expect(run.refused).toBeUndefined()
  expect(run.output).toContain("typed-command-output")
  expect(run.message).toMatchObject({ role: "user", typed: true })
  expect(run.message!.content).toContain("I ran this command myself")
  expect(run.message!.content).toContain("typed-command-output")
  expect(run.message!.display!.startsWith("! echo typed-command-output")).toBe(true)
})

test("a deny rule still stops it, and nothing joins the conversation", async () => {
  const run = await runTypedCommand("echo forbidden-thing", workspace(), neverAsk({ "echo forbidden*": "deny" }))
  expect(run.refused).toContain("echo forbidden*")
  expect(run.message).toBeUndefined()
  // An ask rule is for the model's commands; the person already decided.
  expect((await runTypedCommand("echo asked-thing", workspace(), neverAsk({ "echo asked*": "ask" }))).refused).toBeUndefined()
})

test("the typed flag stays out of what providers are sent", async () => {
  const run = await runTypedCommand("echo wire-check", workspace(), neverAsk())
  let sent = ""
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    if (request.method === "GET") return Response.json({ data: [{ id: "m" }] })
    sent = await request.text()
    return new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } })
  } })
  try {
    const provider = { id: "fixture", label: "Fixture", baseUrl: `http://127.0.0.1:${server.port}/v1/chat/completions`, models: [] }
    for await (const _ of runAgent({ provider, modelId: "m", apiKey: "k", root: workspace(), messages: [run.message!, { role: "user", content: "what did that print?" }] })) {}
    expect(sent).toContain("wire-check")
    expect(sent).not.toContain('"typed"')
    expect(sent).not.toContain('"display"')
  } finally { server.stop(true) }
})
