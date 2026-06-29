import type { Todo, ToolPart } from "@codegoblin/sdk/v2"
import { Icon } from "@codegoblin/ui/icon"
import { getToolInfo } from "@codegoblin/ui/message-part"
import { For, Show, createEffect, createMemo, createSignal, onCleanup, type JSX } from "solid-js"
import { useGlobalSync } from "@/context/global-sync"
import { useSync } from "@/context/sync"

// The live "what's running" view for the right pane — current activity, the
// implementation plan (todos), a feed of recent tool-calls, and a jump-off to
// the diff review. Clean-base styling: neutral deep surface, Inter chrome,
// goblin green (#9ADB35) reserved for the active/working pulse.

const GREEN = "#9ADB35"
const SUCCESS = "var(--v2-state-fg-success)"
const DANGER = "var(--v2-state-fg-danger)"

const SECTION_LABEL =
  "px-4 pt-3 pb-1.5 text-[11px] font-semibold uppercase tracking-wide text-v2-text-text-faint select-none"

type ToolStatus = ToolPart["state"]["status"]

function statusColor(status: ToolStatus): string | undefined {
  if (status === "running") return GREEN
  if (status === "error") return DANGER
  return undefined
}

function partTiming(state: ToolPart["state"]): { start: number; end?: number } | undefined {
  if (state.status === "running") return { start: state.time.start }
  if (state.status === "completed" || state.status === "error")
    return { start: state.time.start, end: state.time.end }
  return undefined
}

function formatDuration(ms: number): string {
  if (ms < 0) return "0s"
  if (ms < 1000) return `${ms}ms`
  const seconds = ms / 1000
  if (seconds < 10) return `${seconds.toFixed(1)}s`
  if (seconds < 60) return `${Math.round(seconds)}s`
  const minutes = Math.floor(seconds / 60)
  return `${minutes}m ${Math.round(seconds % 60)}s`
}

function PulseDot(props: { color: string; pulse?: boolean }) {
  return (
    <span
      class="block size-1.5 shrink-0 rounded-full"
      style={{
        "background-color": props.color,
        "box-shadow": props.pulse ? `0 0 6px ${props.color}` : undefined,
        animation: props.pulse ? "var(--animate-pulse-scale)" : undefined,
        "transform-origin": "center",
      }}
    />
  )
}

function ToolStatusGlyph(props: { part: ToolPart; now: () => number }) {
  const status = () => props.part.state.status
  const timing = createMemo(() => partTiming(props.part.state))
  const duration = createMemo(() => {
    const t = timing()
    if (!t) return undefined
    if (status() === "running") return formatDuration(props.now() - t.start)
    if (t.end !== undefined) return formatDuration(t.end - t.start)
    return undefined
  })

  return (
    <div class="flex shrink-0 items-center gap-1.5">
      <Show when={duration()}>
        <span class="text-[11px] tabular-nums text-v2-text-text-faint">{duration()}</span>
      </Show>
      <Show
        when={status() !== "running"}
        fallback={<PulseDot color={GREEN} pulse />}
      >
        <Show
          when={status() === "error"}
          fallback={
            <Show when={status() === "completed"} fallback={<PulseDot color="var(--v2-text-text-faint)" />}>
              <span style={{ color: SUCCESS }}>
                <Icon name="check" size="small" />
              </span>
            </Show>
          }
        >
          <span style={{ color: DANGER }}>
            <Icon name="close-small" size="small" />
          </span>
        </Show>
      </Show>
    </div>
  )
}

function ToolRow(props: { part: ToolPart; now: () => number }) {
  const info = createMemo(() =>
    getToolInfo(
      props.part.tool,
      props.part.state.input,
      "metadata" in props.part.state ? props.part.state.metadata : undefined,
    ),
  )
  const iconColor = createMemo(() => statusColor(props.part.state.status))

  return (
    <div class="flex items-center gap-2.5 px-4 py-1.5">
      <span
        class="flex size-4 shrink-0 items-center justify-center text-v2-icon-icon-muted"
        style={iconColor() ? { color: iconColor() } : undefined}
      >
        <Icon name={info().icon} size="small" />
      </span>
      <div class="flex min-w-0 flex-1 items-baseline gap-1.5">
        <span class="shrink-0 truncate text-[13px] font-[440] text-v2-text-text-base">{info().title}</span>
        <Show when={info().subtitle}>
          <span class="min-w-0 truncate text-[12px] text-v2-text-text-faint">{info().subtitle}</span>
        </Show>
      </div>
      <ToolStatusGlyph part={props.part} now={props.now} />
    </div>
  )
}

function TodoGlyph(props: { status: Todo["status"] }) {
  return (
    <Show
      when={props.status === "in_progress"}
      fallback={
        <Show
          when={props.status === "completed"}
          fallback={
            <span
              class="mt-[3px] block size-3 shrink-0 rounded-full border"
              classList={{
                "border-v2-border-border-weak": props.status === "pending",
                "border-v2-border-border-weaker opacity-50": props.status === "cancelled",
              }}
            />
          }
        >
          <span class="mt-[1px] flex size-3.5 shrink-0 items-center justify-center" style={{ color: SUCCESS }}>
            <Icon name="check" size="small" />
          </span>
        </Show>
      }
    >
      <span class="mt-[3px] flex size-3 shrink-0 items-center justify-center">
        <PulseDot color={GREEN} pulse />
      </span>
    </Show>
  )
}

function Section(props: { label: string; trailing?: JSX.Element; children: JSX.Element }) {
  return (
    <div class="shrink-0">
      <div class="flex items-center justify-between">
        <div class={SECTION_LABEL}>{props.label}</div>
        <Show when={props.trailing}>
          <div class="px-4 pt-3 pb-1.5 text-[11px] font-medium tabular-nums text-v2-text-text-faint">
            {props.trailing}
          </div>
        </Show>
      </div>
      {props.children}
    </div>
  )
}

export function SessionActivityTab(props: {
  sessionID: () => string | undefined
  hasReview: () => boolean
  reviewCount: () => number
  onOpenReview: () => void
}) {
  const sync = useSync()
  const globalSync = useGlobalSync()

  const status = createMemo(() => {
    const id = props.sessionID()
    if (!id) return { type: "idle" as const }
    return sync.data.session_status[id] ?? { type: "idle" as const }
  })
  const working = createMemo(() => status().type !== "idle")

  const toolParts = createMemo(() => {
    const id = props.sessionID()
    if (!id) return [] as ToolPart[]
    const messages = sync.data.message[id]
    if (!messages) return [] as ToolPart[]
    const out: ToolPart[] = []
    for (const message of messages) {
      if (message.role !== "assistant") continue
      const parts = sync.data.part[message.id]
      if (!parts) continue
      for (const part of parts) {
        if (part.type !== "tool") continue
        if (part.tool === "todowrite") continue
        out.push(part as ToolPart)
      }
    }
    return out
  })

  const running = createMemo(() => toolParts().filter((part) => part.state.status === "running"))
  const recent = createMemo(() =>
    toolParts()
      .filter((part) => part.state.status !== "running")
      .slice(-18)
      .reverse(),
  )

  const todos = createMemo(() => {
    const id = props.sessionID()
    if (!id) return [] as Todo[]
    return globalSync.data.session_todo[id] ?? []
  })
  const todoDone = createMemo(() => todos().filter((todo) => todo.status === "completed").length)
  const todoPct = createMemo(() => {
    const total = todos().length
    if (total === 0) return 0
    return Math.round((todoDone() / total) * 100)
  })

  // Live clock — only ticks while the session is working, to drive running
  // tool elapsed timers and the header label.
  const [now, setNow] = createSignal(Date.now())
  createEffect(() => {
    if (!working()) return
    setNow(Date.now())
    const interval = setInterval(() => setNow(Date.now()), 1000)
    onCleanup(() => clearInterval(interval))
  })

  const headerLabel = createMemo(() => {
    const st = status()
    if (st.type === "retry") return st.message || "Retrying…"
    if (st.type === "idle") return "Idle"
    const active = running()
    const last = active[active.length - 1]
    if (last) {
      const info = getToolInfo(
        last.tool,
        last.state.input,
        "metadata" in last.state ? last.state.metadata : undefined,
      )
      return info.subtitle ? `${info.title} · ${info.subtitle}` : info.title
    }
    return "Thinking…"
  })

  const headerElapsed = createMemo(() => {
    const active = running()
    const last = active[active.length - 1]
    const timing = last ? partTiming(last.state) : undefined
    if (!timing) return undefined
    return formatDuration(now() - timing.start)
  })

  const isEmpty = createMemo(
    () => !working() && running().length === 0 && recent().length === 0 && todos().length === 0,
  )

  return (
    <div class="flex h-full flex-col overflow-hidden bg-v2-background-bg-deep">
      {/* Live status header */}
      <div class="flex h-11 shrink-0 items-center gap-2.5 border-b border-v2-border-border-weaker px-4">
        <PulseDot color={working() ? GREEN : "var(--v2-text-text-faint)"} pulse={working()} />
        <div class="min-w-0 flex-1 truncate text-[13px] font-medium text-v2-text-text-base">{headerLabel()}</div>
        <Show when={working() && headerElapsed()}>
          <span class="shrink-0 text-[11px] tabular-nums text-v2-text-text-faint">{headerElapsed()}</span>
        </Show>
      </div>

      <div class="flex-1 min-h-0 overflow-y-auto py-1 [scrollbar-width:thin]">
        {/* Plan */}
        <Show when={todos().length > 0}>
          <Section label="Plan" trailing={`${todoDone()}/${todos().length}`}>
            <div class="px-4 pb-2 pt-0.5">
              <div class="h-1 overflow-hidden rounded-full bg-v2-overlay-simple-overlay-hover">
                <div
                  class="h-full rounded-full transition-[width] duration-300"
                  style={{ width: `${todoPct()}%`, "background-color": GREEN }}
                />
              </div>
            </div>
            <div class="flex flex-col">
              <For each={todos()}>
                {(todo) => (
                  <div class="flex items-start gap-2.5 px-4 py-1">
                    <TodoGlyph status={todo.status} />
                    <span
                      class="min-w-0 flex-1 text-[13px] leading-snug"
                      classList={{
                        "text-v2-text-text-base font-[480]": todo.status === "in_progress",
                        "text-v2-text-text-muted": todo.status === "pending",
                        "text-v2-text-text-faint line-through": todo.status === "completed",
                        "text-v2-text-text-faint line-through opacity-60": todo.status === "cancelled",
                      }}
                    >
                      {todo.content}
                    </span>
                  </div>
                )}
              </For>
            </div>
          </Section>
        </Show>

        {/* Now running */}
        <Show when={running().length > 0}>
          <Section label="Running">
            <For each={running()}>{(part) => <ToolRow part={part} now={now} />}</For>
          </Section>
        </Show>

        {/* Recent activity */}
        <Show when={recent().length > 0}>
          <Section label="Activity">
            <For each={recent()}>{(part) => <ToolRow part={part} now={now} />}</For>
          </Section>
        </Show>

        {/* Changes → review */}
        <Show when={props.hasReview() && props.reviewCount() > 0}>
          <Section label="Changes" trailing={String(props.reviewCount())}>
            <button
              type="button"
              class="mx-4 mb-2 mt-0.5 flex w-[calc(100%-2rem)] items-center justify-between gap-2 rounded-[6px] border border-v2-border-border-weak px-3 py-2 text-left text-[13px] text-v2-text-text-muted transition-colors hover:bg-v2-overlay-simple-overlay-hover"
              onClick={() => props.onOpenReview()}
            >
              <span class="flex items-center gap-2">
                <Icon name="code-lines" size="small" />
                {props.reviewCount()} {props.reviewCount() === 1 ? "file changed" : "files changed"}
              </span>
              <Icon name="chevron-right" size="small" />
            </button>
          </Section>
        </Show>

        {/* Empty */}
        <Show when={isEmpty()}>
          <div class="flex flex-col items-center justify-center gap-2 px-6 pb-32 pt-24 text-center">
            <div class="text-[13px] text-v2-text-text-faint">Nothing running yet.</div>
            <div class="text-[12px] text-v2-text-text-faint opacity-70">
              Tool calls, the plan, and changes show up here while the goblin digs.
            </div>
          </div>
        </Show>
      </div>
    </div>
  )
}
