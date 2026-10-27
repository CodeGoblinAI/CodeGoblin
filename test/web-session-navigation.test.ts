import { expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"

const source = fs.readFileSync(path.join(import.meta.dir, "../src/web/app.js"), "utf8")
const create = new Function(source.slice(source.indexOf("function createSessionNavigation()"), source.indexOf("let sessionId = null")) + "; return createSessionNavigation")() as
  () => { begin(): number; current(request: number): boolean; finish(request: number): boolean; cancel(): number; pending(): boolean }

test("a later session selection invalidates an earlier response", () => {
  const state = create()
  const first = state.begin()
  const second = state.begin()
  expect(state.current(first)).toBe(false)
  expect(state.current(second)).toBe(true)
  expect(state.finish(second)).toBe(true)
  expect(state.pending()).toBe(false)
})

test("a stale finish cannot unlock a newer pending navigation", () => {
  const state = create()
  const first = state.begin()
  state.begin()
  expect(state.finish(first)).toBe(false)
  expect(state.pending()).toBe(true)
})

test("New session invalidates a pending open without leaving loading stuck", () => {
  const state = create()
  const request = state.begin()
  state.cancel()
  expect(state.current(request)).toBe(false)
  expect(state.finish(request)).toBe(false)
  expect(state.pending()).toBe(false)
})

test("the actual Send guard stays disabled while switching, but Stop stays available", () => {
  const update = new Function("busy", `
    // The composer also sizes itself here, so the stub has a style to set.
    const input = { value: 'newer draft', style: { height: '' }, scrollHeight: 32 }
    const sendBtn = {}
    const attachments = []
    const sessionNavigation = { pending: () => true }
    ${source.slice(source.indexOf("function updateSendButton()"), source.indexOf("function renderAttached()"))}
    updateSendButton()
    return sendBtn.disabled
  `) as (busy: boolean) => boolean
  expect(update(false)).toBe(true)
  expect(update(true)).toBe(false)
})

// Run the actual browser handler with only its network/DOM boundary replaced.
const openSource = source.slice(source.indexOf("async function openSession(id)"), source.indexOf("/**", source.indexOf("async function openSession(id)")))
function navigation(fetcher: (url: string) => Promise<unknown>, catalog = async () => {}) {
  return new Function("fetch", "loadProviders", `
    ${source.slice(source.indexOf("function createSessionNavigation()"), source.indexOf("let sessionId = null"))}
    const sessionNavigation = createSessionNavigation()
    let sessionId = 'original', currentModel = 'local/test', resumeModelMissing = false
    const modelOptions = [{ value: 'local/test' }]
    const thread = { innerHTML: 'original transcript', children: [1] }
    const notices = []
    const input = { value: 'unsent draft', focus() {} }
    const deferUntilIdle = () => false, closeMobilePanels = () => {}, updateSessionNavigation = () => {}
    const setModel = () => true, showUsage = () => {}, turn = () => {}, emptyState = () => {}
    const activityReset = () => {}, refreshSessions = () => {}, note = text => notices.push(text)
    ${openSource}
    return { openSession, cancel: () => sessionNavigation.cancel(), state: () => ({
      sessionId, transcript: thread.innerHTML, draft: input.value, pending: sessionNavigation.pending(), notices
    }) }
  `)(fetcher, catalog) as {
    openSession(id: string): Promise<void>
    cancel(): void
    state(): { sessionId: string; transcript: string; draft: string; pending: boolean; notices: string[] }
  }
}

const response = (selection = "local/test") => ({ ok: true, json: async () => ({ selection, session: { model: "test", messages: [] } }) })

test("the actual session handler ignores a slow response after a newer selection", async () => {
  const slow = Promise.withResolvers<ReturnType<typeof response>>()
  const ui = navigation((url) => url.endsWith("first") ? slow.promise : Promise.resolve(response()))
  const first = ui.openSession("first")
  await ui.openSession("second")
  slow.resolve(response())
  await first
  expect(ui.state().sessionId).toBe("second")
  expect(ui.state().draft).toBe("unsent draft")
  expect(ui.state().pending).toBe(false)
})

test("New session also invalidates an open awaiting its model catalog", async () => {
  const catalog = Promise.withResolvers<void>()
  const entered = Promise.withResolvers<void>()
  const ui = navigation(async () => response("new/model"), () => { entered.resolve(); return catalog.promise })
  const opening = ui.openSession("first")
  await entered.promise
  ui.cancel()
  catalog.resolve()
  await opening
  expect(ui.state()).toMatchObject({ sessionId: "original", transcript: "original transcript", draft: "unsent draft", pending: false })
})

test("failed reads leave the current session and draft intact and unlock retry", async () => {
  const ui = navigation(async () => ({ ok: false }))
  await ui.openSession("unavailable")
  expect(ui.state()).toMatchObject({ sessionId: "original", transcript: "original transcript", draft: "unsent draft", pending: false })
  expect(ui.state().notices[0]).toContain("try again")
})
