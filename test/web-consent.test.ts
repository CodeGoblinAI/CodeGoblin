import { describe, expect, test } from "bun:test"
import { BrowserConsent } from "../src/web/consent"

/**
 * The browser asked its first question fine and every later one failed with
 * "Invalid state: Controller is already closed". Each message opens its own
 * event stream and closes it when its reply ends; consent kept the first one
 * for the life of the conversation, so the second question went nowhere.
 */
const shell = (command: string) => JSON.stringify({ command })
type Sent = { id: string; tool?: string; cover?: string; type?: string }

describe("asking the browser for consent", () => {
  test("a question goes out on the stream of the message that is running", async () => {
    const consent = new BrowserConsent()
    const first: Sent[] = []
    const second: Sent[] = []

    const one = consent.forSession("s1", (event) => first.push(event as Sent))
    const asked = one.decide("shell", shell("git status"))
    expect(first.length).toBe(1)
    // Answered the way /api/permission answers it.
    consent.answer(first[0]!.id, "once")
    expect((await asked).allowed).toBe(true)

    // A second message: same conversation, new stream. The first one is closed
    // by now, so a question sent down it throws instead of prompting.
    const two = consent.forSession("s1", (event) => second.push(event as Sent))
    expect(two).toBe(one)
    const again = two.decide("shell", shell("npm test"))
    expect(second.length).toBe(1)
    expect(first.length).toBe(1)
    consent.answer(second[0]!.id, "once")
    expect((await again).allowed).toBe(true)
  })

  test("an approval lasts the whole conversation, across messages", async () => {
    const consent = new BrowserConsent()
    const sent: Sent[] = []
    const one = consent.forSession("s2", (event) => sent.push(event as Sent))
    const asked = one.decide("shell", shell("git status --short"))
    consent.answer(sent[0]!.id, "always")
    expect((await asked).allowed).toBe(true)

    // The next message must not be asked again - and must not be asked down
    // the stream that has gone.
    const two = consent.forSession("s2", () => {
      throw new Error("asked again")
    })
    expect((await two.decide("shell", shell("git status"))).allowed).toBe(true)
  })

  test("the question says what an approval for the session would cover", async () => {
    const consent = new BrowserConsent()
    const sent: Sent[] = []
    const permissions = consent.forSession("s3", (event) => sent.push(event as Sent))
    const asked = permissions.decide("shell", shell("git commit -m wip"))
    expect(sent[0]).toMatchObject({ type: "permission", tool: "shell", cover: '"git commit"' })
    consent.answer(sent[0]!.id, "reject")
    expect((await asked).allowed).toBe(false)
  })

  test("an answer nobody is waiting for changes nothing, and a malformed one refuses", async () => {
    const consent = new BrowserConsent()
    const sent: Sent[] = []
    const permissions = consent.forSession("s4", (event) => sent.push(event as Sent))
    expect(consent.answer("s4:shell", "once")).toBe(false)

    const asked = permissions.decide("write_file", "{}")
    expect(consent.answer(sent[0]!.id, "yes-obviously")).toBe(true)
    expect((await asked).allowed).toBe(false)
  })

  test("abandoning a turn refuses whatever it was waiting on", async () => {
    const consent = new BrowserConsent()
    const permissions = consent.forSession("s5", () => {})
    const asked = permissions.decide("write_file", "{}")
    expect(consent.pending()).toEqual(["s5:write_file"])

    consent.abandon("s5")
    expect((await asked).allowed).toBe(false)
    expect(consent.pending()).toEqual([])
  })

  test("two conversations keep their own approvals and their own streams", async () => {
    const consent = new BrowserConsent()
    const mine: Sent[] = []
    const yours: Sent[] = []
    const a = consent.forSession("a", (event) => mine.push(event as Sent))
    const b = consent.forSession("b", (event) => yours.push(event as Sent))
    expect(a).not.toBe(b)

    const askedA = a.decide("shell", shell("git status"))
    expect([mine.length, yours.length]).toEqual([1, 0])
    consent.answer(mine[0]!.id, "always")
    await askedA

    // b never approved anything, so b is still asked.
    const askedB = b.decide("shell", shell("git status"))
    expect(yours.length).toBe(1)
    consent.answer(yours[0]!.id, "reject")
    expect((await askedB).allowed).toBe(false)
  })
})
