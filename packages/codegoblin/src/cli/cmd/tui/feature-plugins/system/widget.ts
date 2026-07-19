import { spawn, type ChildProcess } from "node:child_process"
import { createInterface } from "node:readline"
import { existsSync } from "node:fs"
import path from "node:path"
import { nativeBinPath, resolveNativeBinPath } from "@/codegoblin/memory-native"
import type { TuiPlugin } from "@codegoblin/plugin/tui"
import type { InternalTuiPlugin } from "../../plugin/internal"

const id = "internal:widget"

const KV_ENABLED = "widget.enabled"
const KV_SOUND = "widget.sound"
const KV_LAYOUT = "widget.layout"

/**
 * Desktop status widget: a tiny always-on-top native bubble (Rust,
 * `codegoblin-native widget`) showing what the goblin is doing while the
 * terminal is buried under other windows. Windows-only for now.
 *
 * Protocol v2: full JSON snapshots over stdin (all active sessions, question
 * previews, one-shot chime triggers, saved layout); the widget reports user
 * actions (sound toggle, layout moves, interrupt, question answers) as JSON
 * lines on stdout. No server, no polling — the bubble exits with the TUI.
 */

type Row = {
  id: string
  title: string
  status: string
  working: boolean
  done: boolean
  error: boolean
  startedAtMs?: number
  doneAtMs?: number
  spend?: string
  ctx?: string
  todoDone?: number
  todoTotal?: number
  /** internal: last activity for sorting; not sent */
  touched: number
}

type QuestionOut = {
  requestID: string
  sessionID: string
  text: string
  options: string[]
}

type Layout = { mode: "floating"; x: number; y: number } | { mode: "docked"; edge: string; along: number }

const DONE_ROW_TTL = 5 * 60_000
const MAX_ROWS = 4

const tui: TuiPlugin = async (api) => {
  const supported = process.platform === "win32"

  let child: ChildProcess | undefined
  let stopping = false
  let question: QuestionOut | undefined
  const rows = new Map<string, Row>()
  const toolThrottle = new Map<string, number>()
  const usageThrottle = new Map<string, number>()

  function row(sessionID: string): Row {
    let existing = rows.get(sessionID)
    if (!existing) {
      existing = {
        id: sessionID,
        title: api.state.session.get(sessionID)?.title || "CodeGoblin",
        status: "",
        working: false,
        done: false,
        error: false,
        touched: Date.now(),
      }
      rows.set(sessionID, existing)
    }
    return existing
  }

  function activeRows(): Row[] {
    const now = Date.now()
    for (const [key, value] of rows) {
      if (!value.working && (!value.doneAtMs || now - value.doneAtMs > DONE_ROW_TTL)) rows.delete(key)
    }
    return [...rows.values()].sort((a, b) => b.touched - a.touched).slice(0, MAX_ROWS)
  }

  function send(payload: Record<string, unknown>) {
    const stdin = child?.stdin
    if (!stdin || stdin.destroyed) return
    stdin.write(JSON.stringify(payload) + "\n")
  }

  function snapshot(chime?: "done" | "error", extra?: Record<string, unknown>) {
    send({
      sessions: activeRows().map(({ touched: _touched, ...rest }) => rest),
      question: question ?? null,
      ...(chime ? { chime } : {}),
      ...extra,
    })
  }

  function refreshTodo(sessionID: string) {
    const todos = api.state.session.todo(sessionID)
    const target = row(sessionID)
    const counted = todos.filter((t) => t.status !== "cancelled")
    target.todoTotal = counted.length
    target.todoDone = counted.filter((t) => t.status === "completed").length
  }

  function fmtTokens(count: number) {
    if (count >= 1000) return `${(count / 1000).toFixed(1)}K`
    return String(count)
  }

  function refreshUsage(sessionID: string) {
    const messages = api.state.session.messages(sessionID)
    let spend = 0
    let last: (typeof messages)[number] | undefined
    for (const message of messages) {
      if (message.role !== "assistant") continue
      spend += message.cost
      last = message
    }
    const target = row(sessionID)
    if (spend > 0) target.spend = `$${spend.toFixed(2)}`
    if (last && last.role === "assistant") {
      const used = last.tokens.input + last.tokens.cache.read + last.tokens.output
      if (used > 0) {
        const limit = api.state.provider
          .find((p) => p.id === last.providerID)
          ?.models[last.modelID]?.limit?.context
        target.ctx = limit
          ? `${fmtTokens(used)} · ${Math.min(99, Math.round((used / limit) * 100))}%`
          : fmtTokens(used)
      }
    }
  }

  async function start() {
    if (child) return true
    const native = process.env["CODEGOBLIN_NATIVE_BIN"] || nativeBinPath() || (await resolveNativeBinPath())
    if (!native) {
      api.ui.toast({ variant: "error", message: "codegoblin-native binary not found; the widget needs it" })
      return false
    }
    const spawned = spawn(native, ["widget"], {
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
    })
    spawned.on("error", () => {
      if (child === spawned) child = undefined
    })
    spawned.on("exit", () => {
      if (child !== spawned) return
      child = undefined
      // Widget went away without us stopping it (right-click dismiss / hide):
      // treat that as an opt-out until /widget toggles it back on.
      if (!stopping) api.kv.set(KV_ENABLED, false)
    })

    // The widget reports preference changes and actions on stdout.
    if (spawned.stdout) {
      const lines = createInterface({ input: spawned.stdout })
      lines.on("line", (line) => {
        try {
          const event = JSON.parse(line)
          if (event.event === "sound") {
            api.kv.set(KV_SOUND, event.enabled === true)
          } else if (event.event === "layout") {
            const layout: Layout =
              event.mode === "docked"
                ? { mode: "docked", edge: String(event.edge ?? "top"), along: Number(event.along ?? 0) }
                : { mode: "floating", x: Number(event.x ?? 0), y: Number(event.y ?? 0) }
            api.kv.set(KV_LAYOUT, layout)
          } else if (event.event === "interrupt" && typeof event.sessionID === "string") {
            void api.client.session.abort({ sessionID: event.sessionID })
          } else if (event.event === "answer" && typeof event.requestID === "string") {
            if (question?.requestID === event.requestID) question = undefined
            void api.client.question.reply({
              requestID: event.requestID,
              answers: [[String(event.option ?? "")]],
            })
            snapshot()
          }
        } catch {
          // not JSON — ignore
        }
      })
    }

    child = spawned
    stopping = false

    // Initial payload: sound preference, optional custom chime, saved layout.
    const soundPath = [path.join(api.state.path.config, "widget.wav")].find((p) => existsSync(p))
    send({
      sessions: activeRows().map(({ touched: _touched, ...rest }) => rest),
      question: question ?? null,
      sound: api.kv.get<boolean>(KV_SOUND, true),
      ...(soundPath ? { soundPath } : {}),
      ...(api.kv.get<Layout | undefined>(KV_LAYOUT, undefined) ? { layout: api.kv.get<Layout>(KV_LAYOUT) } : {}),
    })
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
    const target = row(sessionID)
    target.touched = Date.now()
    if (type === "busy" || type === "retry") {
      if (!target.working) {
        target.working = true
        target.done = false
        target.error = false
        target.startedAtMs = Date.now()
        target.doneAtMs = undefined
      }
      if (type === "retry") target.status = "retrying…"
      refreshTodo(sessionID)
      snapshot()
      return
    }
    if (type !== "idle" || !target.working) return
    const elapsed = target.startedAtMs ? Math.round((Date.now() - target.startedAtMs) / 1000) : 0
    target.working = false
    target.done = true
    target.doneAtMs = Date.now()
    target.status = target.error
      ? "hit an error — see terminal"
      : `done · ${elapsed >= 60 ? `${Math.floor(elapsed / 60)}m${String(elapsed % 60).padStart(2, "0")}s` : `${elapsed}s`}`
    refreshUsage(sessionID)
    refreshTodo(sessionID)
    snapshot(target.error ? "error" : "done")
  })

  api.event.on("session.error", (event) => {
    const sessionID = event.properties.sessionID
    if (!sessionID) return
    const target = rows.get(sessionID)
    if (!target?.working) return
    target.error = true
  })

  api.event.on("message.part.updated", (event) => {
    const part = event.properties.part
    const target = rows.get(part.sessionID)
    if (!target?.working) return
    if (part.type === "step-finish") {
      const now = Date.now()
      if (now - (usageThrottle.get(part.sessionID) ?? 0) > 2000) {
        usageThrottle.set(part.sessionID, now)
        refreshUsage(part.sessionID)
        snapshot()
      }
      return
    }
    if (part.type !== "tool") return
    if (part.state.status !== "running" && part.state.status !== "pending") return
    const now = Date.now()
    if (now - (toolThrottle.get(part.sessionID) ?? 0) < 300) return
    toolThrottle.set(part.sessionID, now)
    target.status = part.tool
    snapshot()
  })

  api.event.on("todo.updated", (event) => {
    const target = rows.get(event.properties.sessionID)
    if (!target) return
    refreshTodo(event.properties.sessionID)
    snapshot()
  })

  api.event.on("session.updated", (event) => {
    const target = rows.get(event.properties.info.id)
    if (!target) return
    target.title = event.properties.info.title || "CodeGoblin"
    snapshot()
  })

  api.event.on("question.asked", (event) => {
    const request = event.properties
    const first = request.questions[0]
    if (!first) return
    // Only offer inline answers for a single single-select question; anything
    // richer gets a "come back to the terminal" preview without buttons.
    const simple = request.questions.length === 1 && !first.multiple
    question = {
      requestID: request.id,
      sessionID: request.sessionID,
      text: first.question,
      options: simple ? first.options.slice(0, 3).map((o) => o.label) : [],
    }
    const target = rows.get(request.sessionID)
    if (target) target.status = "has a question for you"
    snapshot()
  })

  const clearQuestion = (requestID: string) => {
    if (question?.requestID !== requestID) return
    question = undefined
    snapshot()
  }
  api.event.on("question.replied", (event) => clearQuestion(event.properties.requestID))
  api.event.on("question.rejected", (event) => clearQuestion(event.properties.requestID))

  api.event.on("permission.asked", (event) => {
    const target = rows.get(event.properties.sessionID)
    if (!target?.working) return
    target.status = "needs permission — come back!"
    snapshot()
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
            api.ui.toast({
              variant: "info",
              message: "Status widget on — drag to a screen edge to dock it, right-click to dismiss",
            })
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
