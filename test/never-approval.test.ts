import { describe, expect, test } from "bun:test"
import { CHECKPOINT_TOOL, DECISIONS, Permissions, decisionHints, decisionsFor, type Decision } from "../src/core/permission"
import { BrowserConsent } from "../src/web/consent"

const shell = (command: string) => JSON.stringify({ command })

function answering(...answers: Decision[]) {
  const asked: string[] = []
  const permissions = new Permissions(async (tool, detail) => {
    asked.push(`${tool} ${detail}`)
    return answers.shift() ?? "once"
  })
  return { permissions, asked }
}

describe('"never for this session"', () => {
  test("refuses calls like this one without asking again, and tells the model not to ask", async () => {
    const { permissions, asked } = answering("never")
    const first = await permissions.decide("shell", shell("git push origin main"))
    expect(first).toMatchObject({ allowed: false, by: "user" })
    expect(first.allowed ? "" : first.reason).toContain("do not ask for it again")
    const again = await permissions.decide("shell", shell("git push --force"))
    expect(again).toMatchObject({ allowed: false, by: "user" })
    expect(again.allowed ? "" : again.reason).toContain('never to "git push"')
    expect(asked.length).toBe(1)
  })

  test("covers only what it said: other commands still ask", async () => {
    const { permissions, asked } = answering("never", "once")
    await permissions.decide("shell", shell("git push"))
    expect((await permissions.decide("shell", shell("bun test"))).allowed).toBe(true)
    expect(asked.length).toBe(2)
  })

  test("holds in full access too, like a rule", async () => {
    const { permissions } = answering("never")
    await permissions.decide("webfetch", JSON.stringify({ url: "https://tracker.example/x" }))
    permissions.mode = "full"
    expect((await permissions.decide("webfetch", JSON.stringify({ url: "https://tracker.example/y" }))).allowed).toBe(false)
    expect((await permissions.decide("webfetch", JSON.stringify({ url: "https://docs.example/y" }))).allowed).toBe(true)
  })

  test("never on a secret file keeps it closed for the session", async () => {
    const { permissions, asked } = answering("never")
    permissions.mode = "full"
    await permissions.decide("read_file", JSON.stringify({ path: ".env" }))
    expect((await permissions.decide("shell", shell("type .env"))).allowed).toBe(false)
    expect(asked.length).toBe(1)
  })

  test("a subagent shares it, and a new conversation forgets it", async () => {
    const { permissions, asked } = answering("never", "once")
    await permissions.decide("shell", shell("npm publish"))
    expect((await permissions.forSubagent("explore").decide("shell", shell("npm publish"))).allowed).toBe(false)
    expect(permissions.refusedSummary()).toEqual([`"npm publish"`])
    permissions.reset()
    expect((await permissions.decide("shell", shell("npm publish"))).allowed).toBe(true)
    expect(asked.length).toBe(2)
  })

  test("is offered for tool calls but not at a checkpoint, where rejecting already stops the turn", () => {
    expect(decisionsFor("shell").map((d) => d.id)).toEqual(["once", "always", "reject", "never"])
    expect(decisionsFor(CHECKPOINT_TOOL).map((d) => d.id)).toEqual(["once", "always", "reject"])
    expect(decisionHints("shell", '"git push"').never).toBe('refuse "git push" without asking')
    expect(DECISIONS.at(-1)?.label).toBe("Never for this session")
  })

  test("answering never at a checkpoint anyway (an old page) stops the turn", async () => {
    const permissions = new Permissions(async () => "never")
    expect(await permissions.checkpoint(40, 40)).toBe("stop")
  })

  test("the browser's answer is accepted and sticks for the conversation", async () => {
    const consent = new BrowserConsent()
    const events: { id: string }[] = []
    const permissions = consent.forSession("s1", (event) => events.push(event as { id: string }))
    const waiting = permissions.decide("shell", shell("git push"))
    await Promise.resolve()
    expect(consent.answer(events[0]!.id, "never")).toBe(true)
    expect((await waiting).allowed).toBe(false)
    expect((await permissions.decide("shell", shell("git push"))).allowed).toBe(false)
    expect(events.length).toBe(1)
  })
})
