/** @jsxImportSource @opentui/solid */
import { testRender } from "@opentui/solid"
import type { ScrollBoxRenderable } from "@opentui/core"
import { expect, test } from "bun:test"
import { For } from "solid-js"
import { createStore } from "solid-js/store"
import { KVProvider } from "../../../src/cli/cmd/tui/context/kv"
import { ThemeProvider } from "../../../src/cli/cmd/tui/context/theme"
import { TuiConfigProvider } from "../../../src/cli/cmd/tui/context/tui-config"
import { HistoryControls } from "../../../src/cli/cmd/tui/routes/session/history-controls"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import { Global } from "@codegoblin/core/global"

async function mount(older?: () => Promise<void>) {
  await Bun.write(`${Global.Path.state}/kv.json`, "{}")
  const ready = Promise.withResolvers<void>()
  const [state, setState] = createStore({
    rows: Array.from({ length: 40 }, (_, i) => i + 30),
    page: { cursor: older ? "older" : (undefined as string | undefined), loading: false },
  })
  let scroll!: ScrollBoxRenderable
  const app = await testRender(
    () => (
      <TuiConfigProvider config={createTuiResolvedConfig({ keybinds: {}, leader_timeout: 1000 })}>
        <KVProvider>
          <ThemeProvider mode="dark">
            <box flexGrow={1}>
              <scrollbox
                ref={(value) => {
                  scroll = value
                  ready.resolve()
                }}
                flexGrow={1}
                stickyScroll
                stickyStart="bottom"
              >
                <For each={state.rows}>
                  {(row) => (
                    <box id={`msg_${row}`} height={3} flexShrink={0}>
                      <text>History entry {row}</text>
                    </box>
                  )}
                </For>
              </scrollbox>
              <HistoryControls
                scroll={() => scroll}
                sessionID="ses_history"
                page={state.page}
                onSearch={() => {}}
                onLoadOlder={async () => {
                  setState("page", "loading", true)
                  await older?.()
                  setState("rows", (rows) => [...Array.from({ length: 20 }, (_, i) => i + 10), ...rows])
                  setState("page", { cursor: undefined, loading: false })
                }}
              />
            </box>
          </ThemeProvider>
        </KVProvider>
      </TuiConfigProvider>
    ),
    { width: 90, height: 25 },
  )
  await ready.promise
  await app.renderOnce()
  await app.renderOnce()
  return { app, scroll, setState }
}

test("jump-to-latest appears after scrolling and its actual mouse target returns to the bottom", async () => {
  const local = await mount()
  try {
    expect(local.app.captureCharFrame()).not.toContain("Jump to latest")
    local.scroll.scrollBy(-20)
    await local.app.renderOnce()
    expect(local.app.captureCharFrame()).toContain("Jump to latest")
    const button = local.app.renderer.root.findDescendantById("history-latest")
    expect(button).toBeDefined()
    await local.app.mockMouse.click(button!.x + 2, button!.y)
    await local.app.renderOnce()
    await local.app.renderOnce()
    expect(local.scroll.scrollHeight - local.scroll.viewport.height - local.scroll.scrollTop).toBeLessThanOrEqual(1)
    expect(local.app.captureCharFrame()).not.toContain("Jump to latest")
  } finally {
    local.app.renderer.destroy()
  }
})

test("prepending older history preserves the reading anchor even when a new message arrives", async () => {
  const ready = Promise.withResolvers<void>()
  const complete = Promise.withResolvers<void>()
  const local = await mount(() => {
    ready.resolve()
    return complete.promise
  })
  try {
    local.scroll.scrollTo(2)
    await ready.promise
    await local.app.renderOnce()
    const before = local.scroll
      .getChildren()
      .find((child) => child.id.startsWith("msg_") && child.y + child.height > local.scroll.viewport.y)!
    const offset = before.y - local.scroll.viewport.y
    local.setState("rows", (rows) => [...rows, 70])
    await local.app.renderOnce()
    complete.resolve()
    await Promise.resolve()
    await local.app.renderOnce()
    await local.app.renderOnce()
    const after = local.scroll.getChildren().find((child) => child.id === before.id)!
    expect(after.y - local.scroll.viewport.y).toBe(offset)
    expect(local.app.captureCharFrame()).toContain("History entry 31")
    expect(local.app.captureCharFrame()).toContain("Jump to latest")
  } finally {
    complete.resolve()
    local.app.renderer.destroy()
  }
})

test("jumping to latest during an older-page request stays at the bottom when it completes", async () => {
  const ready = Promise.withResolvers<void>()
  const complete = Promise.withResolvers<void>()
  const local = await mount(() => {
    ready.resolve()
    return complete.promise
  })
  try {
    local.scroll.scrollTo(2)
    await ready.promise
    await local.app.renderOnce()
    const button = local.app.renderer.root.findDescendantById("history-latest")!
    await local.app.mockMouse.click(button.x + 2, button.y)
    complete.resolve()
    await Promise.resolve()
    await local.app.renderOnce()
    await local.app.renderOnce()
    expect(local.scroll.scrollHeight - local.scroll.viewport.height - local.scroll.scrollTop).toBeLessThanOrEqual(1)
    local.app.resize(48, 17)
    await local.app.renderOnce()
    local.scroll.scrollBy(-8)
    await local.app.renderOnce()
    expect(local.app.captureCharFrame()).toContain("Jump to latest")
  } finally {
    complete.resolve()
    local.app.renderer.destroy()
  }
})
