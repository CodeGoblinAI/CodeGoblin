/** @jsxImportSource @opentui/solid */
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { onCleanup } from "solid-js"
import { tmpdir } from "../../fixture/fixture"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"

async function wait(fn: () => boolean, timeout = 2000) {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error("timed out waiting for condition")
    await Bun.sleep(10)
  }
}

async function mountHelp(root: string) {
  const { Global } = await import("@codegoblin/core/global")
  const previous = {
    config: Global.Path.config,
    state: Global.Path.state,
  }
  Global.Path.config = path.join(root, "config")
  Global.Path.state = path.join(root, "state")
  await mkdir(Global.Path.config, { recursive: true })
  await mkdir(Global.Path.state, { recursive: true })
  await Bun.write(path.join(Global.Path.state, "kv.json"), "{}")

  const [
    { DialogProvider },
    { DialogHelp },
    { KVProvider },
    { ThemeProvider },
    { TuiConfigProvider },
    { ToastProvider },
    { OpencodeKeymapProvider, registerOpencodeKeymap },
  ] = await Promise.all([
    import("../../../src/cli/cmd/tui/ui/dialog"),
    import("../../../src/cli/cmd/tui/ui/dialog-help"),
    import("../../../src/cli/cmd/tui/context/kv"),
    import("../../../src/cli/cmd/tui/context/theme"),
    import("../../../src/cli/cmd/tui/context/tui-config"),
    import("../../../src/cli/cmd/tui/ui/toast"),
    import("../../../src/cli/cmd/tui/keymap"),
  ])

  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const resolvedConfig = createTuiResolvedConfig({
      keybinds: {},
      leader_timeout: 1000,
    })
    const off = registerOpencodeKeymap(keymap, renderer, resolvedConfig)
    onCleanup(off)

    return (
      <OpencodeKeymapProvider keymap={keymap}>
        <TuiConfigProvider config={resolvedConfig}>
          <KVProvider>
            <ThemeProvider mode="dark">
              <ToastProvider>
                <DialogProvider>
                  <DialogHelp />
                </DialogProvider>
              </ToastProvider>
            </ThemeProvider>
          </KVProvider>
        </TuiConfigProvider>
      </OpencodeKeymapProvider>
    )
  }

  const app = await testRender(() => <Harness />, { kittyKeyboard: true, width: 90, height: 44 })
  return {
    app,
    async cleanup() {
      app.renderer.destroy()
      Global.Path.config = previous.config
      Global.Path.state = previous.state
    },
  }
}

test("shortcuts dialog renders grouped bindings", async () => {
  await using tmp = await tmpdir()
  const help = await mountHelp(tmp.path)

  try {
    await wait(() => help.app.captureCharFrame().includes("Keyboard shortcuts"))
    const frame = help.app.captureCharFrame()

    expect(frame).toContain("Keyboard shortcuts")
    expect(frame).toContain("Essentials")
    expect(frame).toContain("Send message")
    expect(frame).toContain("Insert newline")
    expect(frame).toContain("Toggle thinking blocks")
    // The list reflects live keymap state: rows resolve to a real binding, or
    // fall back to their slash command, or show an em-dash — never blank.
    for (const line of frame.split("\n")) {
      if (!line.includes("Insert newline")) continue
      expect(line.trim().length).toBeGreaterThan("Insert newline".length)
    }
  } finally {
    await help.cleanup()
  }
})
