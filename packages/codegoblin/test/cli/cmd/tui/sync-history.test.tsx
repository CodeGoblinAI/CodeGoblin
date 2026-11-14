/** @jsxImportSource @opentui/solid */
import { describe, expect, test } from "bun:test"
import { Global } from "@codegoblin/core/global"
import type { UserMessage, TextPart, GlobalEvent } from "@codegoblin/sdk/v2"
import { tmpdir } from "../../../fixture/fixture"
import { directory, json, mount, wait } from "./sync-fixture"
import { formatTranscript } from "../../../../src/cli/cmd/tui/util/transcript"

const sessionID = "ses_history"
const session = {
  id: sessionID,
  title: "Long history",
  directory,
  time: { created: 0, updated: 0 },
  version: "test",
  projectID: "proj_test",
}
function entry(index: number) {
  const id = `msg_${String(index).padStart(4, "0")}`
  const info: UserMessage = {
    id,
    sessionID,
    role: "user",
    time: { created: index },
    agent: "build",
    model: { providerID: "test", modelID: "test" },
  }
  const part: TextPart = { id: `prt_${index}`, messageID: id, sessionID, type: "text", text: `History entry ${index}` }
  return { info, parts: [part] }
}
function updated(index: number): GlobalEvent {
  return {
    directory,
    project: "proj_test",
    payload: { id: `evt_${index}`, type: "message.updated", properties: { sessionID, info: entry(index).info } },
  }
}

async function fixture(options: { total?: number; older?: (url: URL) => Response | Promise<Response> } = {}) {
  await Bun.write(`${Global.Path.state}/kv.json`, "{}")
  const requests: URL[] = []
  const messages = Array.from({ length: options.total ?? 250 }, (_, index) => entry(index))
  const app = await mount((url) => {
    if (url.pathname === `/session/${sessionID}`) return json(session)
    if (url.pathname === `/session/${sessionID}/todo` || url.pathname === `/session/${sessionID}/diff`) return json([])
    if (url.pathname !== `/session/${sessionID}/message`) return undefined
    requests.push(url)
    if (url.searchParams.has("before") && options.older) return options.older(url)
    const end = Number(url.searchParams.get("before") ?? messages.length)
    const start = Math.max(0, end - Number(url.searchParams.get("limit")))
    return json(messages.slice(start, end), { headers: start ? { "X-Next-Cursor": String(start) } : {} })
  })
  await app.sync.session.sync(sessionID)
  return { ...app, requests }
}

describe("TUI history paging", () => {
  test("loads the latest page quickly and reaches every older message without duplicates", async () => {
    await using tmp = await tmpdir()
    const previous = Global.Path.state
    Global.Path.state = tmp.path
    const local = await fixture()
    try {
      expect(local.sync.data.message[sessionID]).toHaveLength(100)
      expect(local.sync.data.message_page[sessionID]?.cursor).toBe("150")
      await local.sync.session.loadOlder(sessionID)
      expect(local.sync.data.message[sessionID]).toHaveLength(200)
      await local.sync.session.loadAll(sessionID)
      expect(local.sync.data.message[sessionID]).toHaveLength(250)
      expect(local.sync.data.message[sessionID].map((message) => message.id)).toEqual(
        Array.from({ length: 250 }, (_, index) => entry(index).info.id),
      )
      expect(local.sync.data.part[entry(0).info.id][0]).toEqual(entry(0).parts[0])
      expect(local.sync.data.message_page[sessionID]?.cursor).toBeUndefined()
      const transcript = formatTranscript(
        session,
        local.sync.data.message[sessionID].map((info) => ({ info, parts: local.sync.data.part[info.id] })),
        { thinking: false, toolDetails: false, assistantMetadata: false },
      )
      expect(transcript).toContain("History entry 0")
      expect(transcript).toContain("History entry 249")
      await local.sync.session.loadOlder(sessionID)
      expect(local.requests).toHaveLength(3)
    } finally {
      local.app.renderer.destroy()
      Global.Path.state = previous
    }
  })

  test("new messages do not evict loaded history or its parts", async () => {
    await using tmp = await tmpdir()
    const previous = Global.Path.state
    Global.Path.state = tmp.path
    const local = await fixture({ total: 100 })
    try {
      local.emit(updated(100))
      await wait(() => local.sync.data.message[sessionID].length === 101)
      expect(local.sync.data.message[sessionID][0].id).toBe(entry(0).info.id)
      expect(local.sync.data.part[entry(0).info.id]).toEqual(entry(0).parts)
    } finally {
      local.app.renderer.destroy()
      Global.Path.state = previous
    }
  })

  test("deduplicates overlapping older-page requests and preserves live messages", async () => {
    await using tmp = await tmpdir()
    const previous = Global.Path.state
    Global.Path.state = tmp.path
    const response = Promise.withResolvers<Response>()
    const local = await fixture({ older: () => response.promise })
    try {
      const first = local.sync.session.loadOlder(sessionID)
      const second = local.sync.session.loadOlder(sessionID)
      await wait(() => local.requests.length === 2)
      local.emit(updated(140))
      local.emit(updated(139))
      await wait(() => local.sync.data.message[sessionID].some((message) => message.id === entry(140).info.id))
      const current = { ...entry(140).parts[0], text: "live update" }
      local.emit({
        directory,
        project: "proj_test",
        payload: { id: "evt_part", type: "message.part.updated", properties: { sessionID, time: 1, part: current } },
      })
      await wait(
        () =>
          local.sync.data.part[current.messageID]?.some(
            (part) => part.type === "text" && part.text === "live update",
          ) ?? false,
      )
      response.resolve(
        json(
          Array.from({ length: 100 }, (_, index) => entry(index + 50)),
          { headers: { "X-Next-Cursor": "50" } },
        ),
      )
      await Promise.all([first, second])
      expect(local.requests).toHaveLength(2)
      expect(local.sync.data.message[sessionID]).toHaveLength(200)
      expect(local.sync.data.part[entry(140).info.id][0]).toEqual(current)
      expect(local.sync.data.part[entry(139).info.id]).toEqual(entry(139).parts)
    } finally {
      response.resolve(json([]))
      local.app.renderer.destroy()
      Global.Path.state = previous
    }
  })

  test("retains the cursor after a failed page and allows retry", async () => {
    await using tmp = await tmpdir()
    const previous = Global.Path.state
    Global.Path.state = tmp.path
    let failed = false
    const local = await fixture({
      older: () => {
        if (!failed) {
          failed = true
          return json({ message: "temporary failure" }, { status: 503 })
        }
        return json(Array.from({ length: 150 }, (_, index) => entry(index)))
      },
    })
    try {
      await expect(local.sync.session.loadOlder(sessionID)).rejects.toBeDefined()
      expect(local.sync.data.message_page[sessionID]?.cursor).toBe("150")
      expect(local.sync.data.message_page[sessionID]?.loading).toBe(false)
      expect(local.sync.data.message_page[sessionID]?.error).toBeDefined()
      await local.sync.session.loadOlder(sessionID)
      expect(local.sync.data.message[sessionID]).toHaveLength(250)
      expect(local.sync.data.message_page[sessionID]?.error).toBeUndefined()
    } finally {
      local.app.renderer.destroy()
      Global.Path.state = previous
    }
  })

  test("stops full-history loading when the server repeats a cursor", async () => {
    await using tmp = await tmpdir()
    const previous = Global.Path.state
    Global.Path.state = tmp.path
    const local = await fixture({ older: () => json([], { headers: { "X-Next-Cursor": "150" } }) })
    try {
      await expect(local.sync.session.loadAll(sessionID)).rejects.toThrow("History pagination did not advance")
      expect(local.requests).toHaveLength(2)
      expect(local.sync.data.message_page[sessionID]?.loading).toBe(false)
      expect(local.sync.data.message_page[sessionID]?.cursor).toBe("150")
      expect(local.sync.data.message[sessionID]).toHaveLength(100)
    } finally {
      local.app.renderer.destroy()
      Global.Path.state = previous
    }
  })

  test("stops loading the full transcript when the search dialog is closed", async () => {
    await using tmp = await tmpdir()
    const previous = Global.Path.state
    Global.Path.state = tmp.path
    const controller = new AbortController()
    const local = await fixture({
      older: () => {
        controller.abort()
        return json(
          Array.from({ length: 100 }, (_, index) => entry(index + 50)),
          { headers: { "X-Next-Cursor": "50" } },
        )
      },
    })
    try {
      await local.sync.session.loadAll(sessionID, controller.signal)
      expect(local.requests).toHaveLength(2)
      expect(local.sync.data.message_page[sessionID]?.cursor).toBe("50")
    } finally {
      local.app.renderer.destroy()
      Global.Path.state = previous
    }
  })
})
