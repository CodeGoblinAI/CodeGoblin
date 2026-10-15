import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"

const source = fs.readFileSync(path.join(import.meta.dir, "../src/web/app.js"), "utf8")
const start = source.indexOf("deferUntilIdle(() => {", source.indexOf("async function submit()"))
const end = source.indexOf('}, text || "attached images")', start) + '}, text || "attached images")'.length
// Execute the actual handoff, with only the UI/send boundary replaced. The
// real browser and PTY passes separately exercise asynchronous model changes.
const handoff = new Function("text", "draft", "images", "completion", `
  const input = { value: draft }
  const queuedImages = []
  let attachments = images
  let sent
  let refreshed = false
  const renderAttached = () => {}
  const refreshPalette = () => { refreshed = true }
  const sendText = (text) => { sent = text; input.value = completion; attachments = [] }
  const deferUntilIdle = (action) => action()
  ${source.slice(start, end)}
  return { draft: input.value, images: attachments, sent, refreshed }
`) as (text: string, draft: string, images: string[], completion: string) => { draft: string; images: string[]; sent: string; refreshed: boolean }

describe("queued Web command handoff", () => {
  test("a newer text draft survives a queued model command", () => {
    expect(handoff("/model local/fixture", "newer unsent text", [], "")).toEqual({
      draft: "newer unsent text", images: [], sent: "/model local/fixture", refreshed: true,
    })
  })

  test("an image-only newer draft survives a queued control", () => {
    expect(handoff("/clear", "", ["newer image"], "").images).toEqual(["newer image"])
  })

  test("without a newer draft, a command may still prepare its argument field", () => {
    expect(handoff("/model", "", [], "/model ").draft).toBe("/model ")
  })
})
