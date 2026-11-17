import { expect, test } from "bun:test"
import * as sessions from "../src/core/sessions"

/**
 * The same conversation open in two windows - the terminal and the web, or two terminals. Each used to save
 * its own whole copy, so whichever saved last wiped out the other's turns.
 */
const contents = (session: sessions.Session | undefined) => session?.messages.map((message) => message.content) ?? []
const started = async () => {
  const first = sessions.create("local", "fixture")
  first.title = "The parser"
  first.messages.push({ role: "user", content: "start" }, { role: "assistant", content: "ok" })
  await sessions.save(first)
  return first.id
}
// Two saves a moment apart can share a file time on Windows; the size still tells them apart, so no real
// pause is needed between the windows.
const tick = () => Bun.sleep(0)

test("both carried it on: neither window's turns are lost, and the one saving second becomes a copy", async () => {
  const id = await started()
  const terminal = (await sessions.load(id))!
  const web = (await sessions.load(id))!
  web.messages.push({ role: "user", content: "said on the web" }, { role: "assistant", content: "web answer" })
  await sessions.save(web)
  await tick()
  terminal.messages.push({ role: "user", content: "said in the terminal" }, { role: "assistant", content: "terminal answer" })
  const saved = await sessions.save(terminal)
  expect(saved.copiedFrom).toBe(id)
  expect(terminal.id).not.toBe(id)
  expect(terminal.title).toBe("The parser (this window)")
  expect(contents(await sessions.load(id))).toEqual(["start", "ok", "said on the web", "web answer"])
  expect(contents(await sessions.load(terminal.id))).toEqual(["start", "ok", "said in the terminal", "terminal answer"])
  // The copy carries on as itself from then on.
  terminal.messages.push({ role: "user", content: "more" })
  expect((await sessions.save(terminal)).copiedFrom).toBeUndefined()
})

test("renamed or pinned in the other window only: saved as itself, keeping that name and pin", async () => {
  const id = await started()
  const terminal = (await sessions.load(id))!
  await tick()
  await sessions.rename(id, "Parser rewrite")
  await sessions.pin(id, true)
  terminal.messages.push({ role: "user", content: "carry on" })
  expect((await sessions.save(terminal)).copiedFrom).toBeUndefined()
  const now = await sessions.load(id)
  expect(now?.title).toBe("Parser rewrite")
  expect(now?.pinned).toBe(true)
  expect(contents(now)).toEqual(["start", "ok", "carry on"])
})

test("one window saving again and again never makes a copy", async () => {
  const id = await started()
  const only = (await sessions.load(id))!
  for (let n = 0; n < 5; n++) {
    only.messages.push({ role: "user", content: "message " + n })
    expect((await sessions.save(only)).copiedFrom).toBeUndefined()
  }
  expect(only.id).toBe(id)
})
