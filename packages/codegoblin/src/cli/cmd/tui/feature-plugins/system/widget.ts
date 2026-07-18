import { spawn, type ChildProcess } from "node:child_process"
import { nativeBinPath, resolveNativeBinPath } from "@/codegoblin/memory-native"
import type { TuiPlugin, TuiPluginApi } from "@codegoblin/plugin/tui"
import type { InternalTuiPlugin } from "../../plugin/internal"

const id = "internal:widget"

const KV_ENABLED = "widget.enabled"

/**
 * Desktop status widget: a tiny always-on-top native bubble (Rust,
 * `codegoblin-native widget`) showing what the goblin is doing while the
 * terminal is buried under other windows. Windows-only for now.
 *
 * The bubble is fed JSON lines over stdin — no server, no polling. It exits
 * when the TUI exits (stdin EOF) or when the user right-clicks it away.
 */

type WidgetUpdate = {
  title?: string
  status?: string
  working?: boolean
  spend?: string
  startedAtMs?: number | null
}

const tui: TuiPlugin = async (api) => {
  const supported = process.platform === "win32"

  let child: ChildProcess | undefined
  let watched: string | undefined
  let startedAt: number | undefined
  let lastToolAt = 0
  let stopping = false

  function send(update: WidgetUpdate) {
    const stdin = child?.stdin
    if (!stdin || stdin.destroyed) return
    stdin.write(JSON.stringify(update) + "\n")
  }

  function sessionTitle(sessionID: string | undefined) {
    if (!sessionID) return "CodeGoblin"
    return api.state.session.get(sessionID)?.title || "CodeGoblin"
  }

  function pushSnapshot(sessionID: string | undefined, status?: string) {
    const type = sessionID ? (api.state.session.status(sessionID)?.type ?? "idle") : "idle"
    const working = type === "busy" || type === "retry"
    send({
      title: sessionTitle(sessionID),
      working,
      status: status ?? (type === "retry" ? "retrying…" : working ? "goblin working…" : "idle"),
      startedAtMs: working ? (startedAt ?? Date.now()) : null,
    })
  }

  async function start() {
    if (child) return true
    const native = process.env["CODEGOBLIN_NATIVE_BIN"] || nativeBinPath() || (await resolveNativeBinPath())
    if (!native) {
      api.ui.toast({ variant: "error", message: "codegoblin-native binary not found; the widget needs it" })
      return false
    }
    const spawned = spawn(native, ["widget"], {
      stdio: ["pipe", "ignore", "ignore"],
      windowsHide: true,
    })
    spawned.on("error", () => {
      if (child === spawned) child = undefined
    })
    spawned.on("exit", () => {
      if (child !== spawned) return
      child = undefined
      // Widget went away without us stopping it (right-click dismiss):
      // treat that as an opt-out until /widget toggles it back on.
      if (!stopping) api.kv.set(KV_ENABLED, false)
    })
    child = spawned
    stopping = false
    pushSnapshot(watched)
    return true
  }

  function stop() {
    if (!child) return
    stopping = true
    child.stdin?.end()
    const dying = child
    child = undefined
    setTimeout(() => {
      if (!dying.killed) dying.kill()
    }, 1500).unref?.()
  }

  api.event.on("session.status", (event) => {
    const sessionID = event.properties.sessionID
    const type = event.properties.status.type
    if (type === "busy" || type === "retry") {
      if (watched !== sessionID) {
        watched = sessionID
        startedAt = Date.now()
      } else if (startedAt === undefined) {
        startedAt = Date.now()
      }
      pushSnapshot(sessionID)
      return
    }
    if (sessionID !== watched) return
    startedAt = undefined
    pushSnapshot(sessionID)
  })

  api.event.on("message.part.updated", (event) => {
    const part = event.properties.part
    if (part.type !== "tool") return
    if (part.sessionID !== watched) return
    if (part.state.status !== "running" && part.state.status !== "pending") return
    const now = Date.now()
    if (now - lastToolAt < 300) return
    lastToolAt = now
    send({ status: part.tool, working: true })
  })

  api.event.on("permission.asked", (event) => {
    if (event.properties.sessionID !== watched) return
    send({ status: "needs permission — come back!" })
  })

  api.event.on("question.asked", (event) => {
    if (event.properties.sessionID !== watched) return
    send({ status: "has a question for you" })
  })

  api.event.on("session.updated", (event) => {
    if (event.properties.info.id !== watched) return
    send({ title: event.properties.info.title || "CodeGoblin" })
  })

  api.keymap.registerLayer({
    commands: [
      {
        name: "widget.toggle",
        title: "Toggle status widget",
        desc: "Floating always-on-top bubble showing what the goblin is doing",
        slashName: "widget",
        category: "System",
        namespace: "palette",
        async run() {
          if (!supported) {
            api.ui.toast({ variant: "info", message: "The status widget is Windows-only for now" })
            return
          }
          if (child) {
            stop()
            api.kv.set(KV_ENABLED, false)
            api.ui.toast({ variant: "info", message: "Status widget hidden" })
            return
          }
          if (await start()) {
            api.kv.set(KV_ENABLED, true)
            api.ui.toast({ variant: "info", message: "Status widget on — drag to move, double-click to focus, right-click to dismiss" })
          }
        },
      },
    ],
  })

  if (supported && api.kv.get<boolean>(KV_ENABLED, false)) {
    void start()
  }
}

const plugin: InternalTuiPlugin = {
  id,
  tui,
}

export default plugin
