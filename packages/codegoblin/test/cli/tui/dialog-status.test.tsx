/** @jsxImportSource @opentui/solid */
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { expect, spyOn, test } from "bun:test"
import { onCleanup, onMount } from "solid-js"
import { pathToFileURL } from "node:url"
import path from "node:path"
import { Global } from "@codegoblin/core/global"
import { ArgsProvider } from "../../../src/cli/cmd/tui/context/args"
import { ExitProvider } from "../../../src/cli/cmd/tui/context/exit"
import { KVProvider } from "../../../src/cli/cmd/tui/context/kv"
import { LocalProvider, useLocal } from "../../../src/cli/cmd/tui/context/local"
import { ProjectProvider } from "../../../src/cli/cmd/tui/context/project"
import { RouteProvider, useRoute } from "../../../src/cli/cmd/tui/context/route"
import { SDKProvider } from "../../../src/cli/cmd/tui/context/sdk"
import { SyncProvider, useSync } from "../../../src/cli/cmd/tui/context/sync"
import { ThemeProvider } from "../../../src/cli/cmd/tui/context/theme"
import { TuiConfigProvider } from "../../../src/cli/cmd/tui/context/tui-config"
import { DialogProvider, useDialog } from "../../../src/cli/cmd/tui/ui/dialog"
import { ToastProvider } from "../../../src/cli/cmd/tui/ui/toast"
import { DialogStatus } from "../../../src/cli/cmd/tui/component/dialog-status"
import { OpencodeKeymapProvider, registerOpencodeKeymap } from "../../../src/cli/cmd/tui/keymap"
import * as Clipboard from "../../../src/cli/cmd/tui/util/clipboard"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import { tmpdir } from "../../fixture/fixture"
import { createFetch, eventSource, json, wait } from "../cmd/tui/sync-fixture"

const sessionID = "ses_status_fixture"
const session = {
  id: sessionID,
  title: "Status UX fixture",
  directory: "/tmp/status-project",
  projectID: "proj_status",
  version: "fixture",
  time: { created: 1, updated: 1 },
}

async function mount(
  root: string,
  options: { home?: boolean; parent?: string; connected?: boolean; health?: () => Response } = {},
) {
  const previous = Global.Path.state
  const hangups = new Set(process.listeners("SIGHUP"))
  Global.Path.state = root
  await Bun.write(path.join(root, "kv.json"), "{}")
  const requests: string[] = []
  const calls = createFetch((url) => {
    requests.push(url.pathname)
    if (options.connected === false && url.pathname === "/config/providers") return json({ providers: [], default: {} })
    if (options.connected === false && url.pathname === "/agent") return json([])
    if (url.pathname === "/global/health")
      return options.health?.() ?? json({ healthy: true, version: "fixture-server" })
    if (url.pathname === "/session") return json([{ ...session, parentID: options.parent }])
    if (url.pathname === "/path")
      return json({
        directory: session.directory,
        worktree: "/tmp/status-project",
        home: "/tmp/home",
        state: root,
        config: "/tmp/config",
      })
    if (url.pathname === "/config")
      return json({
        plugin: ["@fixture/plugin@1.2.3", pathToFileURL(path.join(root, "fixture-plugin", "index.ts")).href],
        provider: { fixture: { options: { apiKey: "config-secret" } } },
      })
    if (url.pathname === "/mcp")
      return json({
        working: { status: "connected" },
        login: { status: "needs_auth" },
        broken: { status: "failed", error: "Connection refused" },
        disabled: { status: "disabled" },
      })
    if (url.pathname === "/lsp") return json([{ id: "typescript", root: session.directory, status: "connected" }])
    if (url.pathname === "/formatter")
      return json([
        { name: "prettier", enabled: true },
        { name: "disabled-formatter", enabled: false },
      ])
    if (url.pathname === "/agent")
      return json([{ name: "build", mode: "primary", model: { providerID: "fixture", modelID: "selected" } }])
    if (url.pathname === "/session/status") return json({ [sessionID]: { type: "busy" } })
    if (url.pathname === "/config/providers")
      return json({
        providers: [
          {
            id: "fixture",
            name: "Fixture Provider",
            source: "api",
            key: "provider-secret",
            options: { apiKey: "options-secret" },
            models: {
              selected: { id: "selected", providerID: "fixture", name: "Selected model", variants: { high: {} } },
              previous: { id: "previous", providerID: "fixture", name: "Previous model" },
            },
          },
        ],
        default: { fixture: "selected" },
      })
    return undefined
  })
  const ready = Promise.withResolvers<void>()
  let sync!: ReturnType<typeof useSync>
  let route!: ReturnType<typeof useRoute>
  let local!: ReturnType<typeof useLocal>
  let dialog!: ReturnType<typeof useDialog>
  function Probe() {
    sync = useSync()
    route = useRoute()
    local = useLocal()
    dialog = useDialog()
    onMount(() => ready.resolve())
    return <box />
  }
  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const config = createTuiResolvedConfig()
    onCleanup(registerOpencodeKeymap(keymap, renderer, config))
    return (
      <OpencodeKeymapProvider keymap={keymap}>
        <TuiConfigProvider config={config}>
          <ArgsProvider model="fixture/selected">
            <ExitProvider>
              <KVProvider>
                <SDKProvider url="http://test" directory={session.directory} fetch={calls.fetch} events={eventSource()}>
                  <ProjectProvider>
                    <SyncProvider>
                      <ThemeProvider mode="dark">
                        <ToastProvider>
                          <RouteProvider
                            initialRoute={options.home ? { type: "home" } : { type: "session", sessionID }}
                          >
                            <LocalProvider>
                              <DialogProvider>
                                <Probe />
                              </DialogProvider>
                            </LocalProvider>
                          </RouteProvider>
                        </ToastProvider>
                      </ThemeProvider>
                    </SyncProvider>
                  </ProjectProvider>
                </SDKProvider>
              </KVProvider>
            </ExitProvider>
          </ArgsProvider>
        </TuiConfigProvider>
      </OpencodeKeymapProvider>
    )
  }
  const app = await testRender(() => <Harness />, { width: 100, height: 44, kittyKeyboard: true })
  await ready.promise
  await wait(() => sync.status === "complete")
  local.model.variant.set("high")
  dialog.replace(() => <DialogStatus />)
  await wait(() => requests.includes("/global/health"))
  await app.renderOnce()
  await app.renderOnce()
  return {
    app,
    requests,
    local,
    route,
    dialog,
    cleanup() {
      app.renderer.destroy()
      // ExitProvider owns a process-level hook; do not leak it into other tests.
      for (const listener of process.listeners("SIGHUP")) {
        if (!hangups.has(listener)) process.removeListener("SIGHUP", listener)
      }
      Global.Path.state = previous
    },
  }
}

test("status shows real session identity, selected model and health without exposing credentials", async () => {
  await using tmp = await tmpdir()
  const ui = await mount(tmp.path)
  try {
    await wait(() => ui.app.captureCharFrame().includes("fixture-server"))
    const frame = ui.app.captureCharFrame()
    for (const text of [
      "Status UX fixture",
      sessionID,
      "selected",
      "Fixture Provider",
      "Saved credential",
      "build",
      "high",
      "busy",
      session.directory,
      "Healthy",
      "1 connected · 1 need auth · 1 failed · 1 disabled",
    ])
      expect(frame).toContain(text)
    for (const secret of ["provider-secret", "options-secret", "config-secret"]) expect(frame).not.toContain(secret)
    expect(ui.requests.every((request) => request !== "/auth" && !request.includes("/usage"))).toBe(true)
    ui.local.model.set({ providerID: "fixture", modelID: "previous" })
    await ui.app.renderOnce()
    expect(ui.app.captureCharFrame()).toContain("previous")
  } finally {
    ui.cleanup()
  }
})

test("connections tab preserves diagnostics and supports actual keyboard and mouse targets", async () => {
  await using tmp = await tmpdir()
  const ui = await mount(tmp.path)
  try {
    await ui.app.mockInput.pressArrow("right")
    await ui.app.renderOnce()
    const frame = ui.app.captureCharFrame()
    for (const text of [
      "4 MCP Servers",
      "Connection refused",
      "Needs authentication",
      "typescript",
      "prettier",
      "@fixture/plugin",
      "fixture-plugin",
    ])
      expect(frame).toContain(text)
    expect(frame).not.toContain("disabled-formatter")
    const target = ui.app.renderer.root.findDescendantById("status-tab-status")!
    await ui.app.mockMouse.click(target.x + 1, target.y)
    await ui.app.renderOnce()
    expect(ui.app.captureCharFrame()).toContain(sessionID)
  } finally {
    ui.cleanup()
  }
})

test("status handles home and child sessions without inventing session IDs", async () => {
  await using tmp = await tmpdir()
  const ui = await mount(tmp.path, { home: true, parent: "ses_parent_fixture" })
  try {
    expect(ui.app.captureCharFrame()).toContain("No session open")
    expect(ui.app.captureCharFrame()).not.toContain("c copy ID")
    ui.route.navigate({ type: "session", sessionID })
    await ui.app.renderOnce()
    expect(ui.app.captureCharFrame()).toContain("Child conversation")
    expect(ui.app.captureCharFrame()).toContain("ses_parent_fixture")
  } finally {
    ui.cleanup()
  }
})

test("status is available before connecting a provider", async () => {
  await using tmp = await tmpdir()
  const ui = await mount(tmp.path, { home: true, connected: false })
  try {
    expect(ui.app.captureCharFrame()).toContain("No session open")
    expect(ui.app.captureCharFrame()).toContain("Not selected")
    expect(ui.app.captureCharFrame()).not.toContain("Fixture Provider")
  } finally {
    ui.cleanup()
  }
})

test("status recovers from a failed health check and copies the current ID", async () => {
  await using tmp = await tmpdir()
  let healthy = false
  const ui = await mount(tmp.path, {
    health: () =>
      healthy ? json({ healthy: true, version: "recovered-server" }) : json({ error: "unavailable" }, { status: 503 }),
  })
  const copy = spyOn(Clipboard, "copy").mockResolvedValue()
  try {
    await wait(() => ui.app.captureCharFrame().includes("Unavailable"))
    healthy = true
    await ui.app.mockInput.pressKey("r")
    await wait(() => ui.requests.filter((request) => request === "/global/health").length === 2)
    await ui.app.renderOnce()
    await wait(() => ui.app.captureCharFrame().includes("recovered-server"))
    await ui.app.mockInput.pressKey("c")
    expect(copy).toHaveBeenCalledWith(sessionID)
    ui.app.mockInput.pressEscape()
    await ui.app.renderOnce()
    expect(ui.dialog.stack).toHaveLength(0)
  } finally {
    copy.mockRestore()
    ui.cleanup()
  }
})

test("status stays scrollable in a narrow, short terminal", async () => {
  await using tmp = await tmpdir()
  const ui = await mount(tmp.path)
  try {
    ui.app.resize(48, 20)
    await ui.app.renderOnce()
    expect(ui.app.captureCharFrame()).toContain("Status")
    expect(ui.app.captureCharFrame()).toContain("/usage for spend")
    for (let index = 0; index < 8; index++) ui.app.mockInput.pressKey("\u001b[6~")
    await ui.app.renderOnce()
    expect(ui.app.captureCharFrame()).toContain("Config directory")
    expect(ui.app.captureCharFrame()).toContain("/tmp/config")
  } finally {
    ui.cleanup()
  }
})
