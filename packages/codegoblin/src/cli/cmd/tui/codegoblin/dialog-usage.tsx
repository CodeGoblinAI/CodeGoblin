import { For, Show, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import type { UsageSnapshot } from "@codegoblin/core/usage"
import { useRoute } from "@tui/context/route"
import { useSDK } from "@tui/context/sdk"
import { useDialog } from "@tui/ui/dialog"
import { useTheme } from "@tui/context/theme"
import { useBindings } from "@tui/keymap"
import { TextAttributes } from "@opentui/core"

type Detail = { label: string; value: string; muted?: boolean }

type Entry = {
  key: string
  title: string
  /**
   * The one number worth seeing without opening anything. Deliberately not the
   * same content as `details` — the index is a menu, and repeating the
   * breakdown in it defeats the point of having a detail view at all.
   */
  headline: string
  details: Detail[]
  /** Unavailable providers stay listed but cannot be opened. */
  disabled?: boolean
}

export function DialogUsage() {
  const sdk = useSDK()
  const route = useRoute()
  const dialog = useDialog()
  const { theme } = useTheme()
  const [snapshot, setSnapshot] = createSignal<UsageSnapshot>()
  const [loading, setLoading] = createSignal(true)
  const [refreshing, setRefreshing] = createSignal(false)
  const [error, setError] = createSignal<string>()
  // The selection follows the entry's key, not its position: a refresh can add,
  // drop or reorder rows, and an index would silently end up on a different
  // provider than the one that was highlighted.
  const [cursorKey, setCursorKey] = createSignal<string>()
  const [openKey, setOpenKey] = createSignal<string>()
  let poll: ReturnType<typeof setTimeout> | undefined
  let disposed = false

  /**
   * `cached` reads what the last CLI turn left behind, `auto` re-reads whatever
   * has aged past its TTL, `force` re-reads everything. Opening the panel does
   * the first two back to back so it paints immediately and then corrects
   * itself, rather than blocking on a CLI spawn.
   */
  const refresh = async (mode: "cached" | "auto" | "force" | "poll") => {
    if (mode === "cached" && !snapshot()) setLoading(true)
    if (mode === "auto" || mode === "force") setRefreshing(true)
    setError(undefined)
    const sessionID = route.data.type === "session" ? route.data.sessionID : undefined
    const query = new URLSearchParams({
      ...(sessionID ? { sessionID } : {}),
    })
    if (mode === "auto" || mode === "force") {
      await sdk
        .fetch(`${sdk.url}/codegoblin/usage/refresh`, {
          method: "POST",
          headers: {
            "x-codegoblin-action": "usage-refresh",
            "x-codegoblin-refresh": mode,
          },
        })
        .catch(() => undefined)
    }
    const response = await sdk.fetch(`${sdk.url}/codegoblin/usage?${query}`).catch(() => undefined)
    const value = response?.ok ? ((await response.json().catch(() => undefined)) as UsageSnapshot | undefined) : undefined
    if (disposed) return
    if (!value) {
      // A failed background refresh must not blank out figures already on screen.
      if (!snapshot()) setError(response?.ok ? "Usage returned an invalid response." : "Usage is unavailable right now.")
    } else setSnapshot(value)
    setLoading(false)
    setRefreshing(Boolean(value?.refreshing))
    if (poll) clearTimeout(poll)
    if (value?.refreshing) poll = setTimeout(() => void refresh("poll"), 1_500)
  }

  const entries = createMemo<Entry[]>(() => {
    const value = snapshot()
    if (!value) return []
    const out: Entry[] = []

    if (value.session) out.push(totalsEntry("session", "Current session", value.session))
    out.push(totalsEntry("aggregate", "All sessions", value.aggregate))

    // One row per subscription, so a provider's windows read together in its
    // own view instead of as a flat wall of lines here.
    const byProvider = new Map<string, UsageSnapshot["quotas"]>()
    for (const quota of value.quotas) {
      byProvider.set(quota.providerID, [...(byProvider.get(quota.providerID) ?? []), quota])
    }
    // `value.quotas` arrives in the order the providers last wrote their quota
    // file, so it flips whenever one of them refreshes. Follow the server's
    // fixed provider order instead, so a row never moves under the cursor.
    const rank = (providerID: string) => {
      const index = value.quotaStatuses?.findIndex((item) => item.providerID === providerID) ?? -1
      return index < 0 ? Number.MAX_SAFE_INTEGER : index
    }
    const ordered = [...byProvider].sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
    for (const [providerID, quotas] of ordered) {
      const label = value.quotaStatuses?.find((item) => item.providerID === providerID)?.label ?? providerID
      // The window closest to running out is the one that will actually stop
      // you, so that is the headline; the rest is a keypress away.
      const tightest = [...quotas].sort((a, b) => a.remainingPercentage - b.remainingPercentage)[0]
      out.push({
        key: `quota:${providerID}`,
        title: label,
        headline: `${tightest.window} ${Math.round(tightest.remainingPercentage)}% left`,
        details: [
          ...quotas.map((quota) => ({
            label: quota.window,
            value: `${Math.round(quota.remainingPercentage)}% left · ${Math.round(quota.usedPercentage)}% used${
              quota.resetsAt ? ` · resets in ${quota.resetsAt}` : ""
            }`,
          })),
          ...(quotas[0]?.checkedAt ? [{ label: "checked", value: since(quotas[0].checkedAt), muted: true }] : []),
        ],
      })
    }

    for (const status of value.quotaStatuses ?? []) {
      if (status.available) continue
      out.push({ key: `unavailable:${status.providerID}`, title: status.label, headline: "—", details: [], disabled: true })
    }

    if (value.balances.length) {
      out.push({
        key: "balances",
        title: "API balances",
        headline: value.balances.map((item) => `${item.amount}${item.unit === "USD" ? "" : ` ${item.unit}`}`).join(" · "),
        details: value.balances.map((item) => ({
          label: item.label,
          value: `${item.amount} ${item.unit}${item.live ? "" : " (manual)"}`,
        })),
      })
    }
    return out
  })

  const selectable = createMemo(() => entries().filter((entry) => !entry.disabled))
  const opened = createMemo(() => entries().find((entry) => entry.key === openKey()))
  /** Pad titles to a common width so the values line up in one column. */
  const titleWidth = createMemo(() => Math.max(0, ...entries().map((entry) => entry.title.length)))
  const detailWidth = createMemo(() => Math.max(0, ...(opened()?.details ?? []).map((item) => item.label.length)))

  /** The highlighted entry, falling back to the first row once the list loads
   * or when the previously selected row disappears. */
  const active = createMemo(() => {
    const list = selectable()
    return list.find((entry) => entry.key === cursorKey()) ?? list[0]
  })
  const move = (delta: number) => {
    const list = selectable()
    if (!list.length) return
    const current = list.findIndex((entry) => entry.key === active()?.key)
    setCursorKey(list[(Math.max(0, current) + delta + list.length) % list.length].key)
  }
  const open = () => {
    const entry = active()
    if (entry) setOpenKey(entry.key)
  }

  onMount(async () => {
    await refresh("cached")
    void refresh("auto")
  })
  onCleanup(() => {
    disposed = true
    if (poll) clearTimeout(poll)
  })
  useBindings(() => ({
    bindings: [
      { key: "r", desc: "Refresh usage", group: "Dialog", cmd: () => void refresh("force") },
      { key: "up", desc: "Previous", group: "Dialog", cmd: () => move(-1) },
      { key: "down", desc: "Next", group: "Dialog", cmd: () => move(1) },
      { key: "k", desc: "Previous", group: "Dialog", cmd: () => move(-1) },
      { key: "j", desc: "Next", group: "Dialog", cmd: () => move(1) },
      { key: "return", desc: "Open details", group: "Dialog", cmd: () => open() },
      {
        key: "escape",
        desc: "Back",
        group: "Dialog",
        // Escape steps out of a detail view first, so it never closes the
        // whole dialog while the user is one level deep.
        cmd: () => (openKey() ? setOpenKey(undefined) : dialog.clear()),
      },
    ],
  }))

  return (
    <box paddingLeft={2} paddingRight={2} gap={1} paddingBottom={1}>
      <box flexDirection="row" justifyContent="space-between" gap={2}>
        <text fg={theme.text} attributes={TextAttributes.BOLD} wrapMode="none">
          {opened() ? `Usage · ${opened()!.title}` : "Usage"}
        </text>
        <box flexDirection="row" gap={1} flexShrink={0}>
          <Show when={refreshing()}>
            <text fg={theme.textMuted}>refreshing…</text>
          </Show>
          <text fg={theme.textMuted} onMouseUp={() => (openKey() ? setOpenKey(undefined) : dialog.clear())}>
            {opened() ? "back" : "esc"}
          </text>
        </box>
      </box>

      <Show when={!loading()} fallback={<text fg={theme.textMuted}>Loading usage…</text>}>
        <Show when={snapshot()} fallback={<text fg={theme.error}>{error() ?? "Usage unavailable."}</text>}>
          <Show
            when={opened()}
            fallback={
              <box gap={0}>
                <For each={entries()}>
                  {(entry) => {
                    const selected = () => !entry.disabled && active()?.key === entry.key
                    return (
                      <box
                        flexDirection="row"
                        gap={1}
                        onMouseUp={() => {
                          if (entry.disabled) return
                          setCursorKey(entry.key)
                          setOpenKey(entry.key)
                        }}
                      >
                        <text fg={selected() ? theme.primary : theme.textMuted}>{selected() ? "❯" : " "}</text>
                        <text
                          fg={entry.disabled ? theme.textMuted : selected() ? theme.text : theme.textMuted}
                          wrapMode="none"
                        >
                          {entry.title.padEnd(titleWidth())}
                        </text>
                        <text fg={theme.textMuted} wrapMode="none">
                          {entry.headline}
                        </text>
                      </box>
                    )
                  }}
                </For>
                <text fg={theme.textMuted}>enter details · r refresh · esc close</text>
              </box>
            }
          >
            {(entry) => (
              <box gap={0}>
                <Show when={entry().details.length} fallback={<text fg={theme.textMuted}>{entry().headline}</text>}>
                  <For each={entry().details}>
                    {(detail) => (
                      <box flexDirection="row" gap={1}>
                        <text fg={detail.muted ? theme.textMuted : theme.text} wrapMode="none">
                          {detail.label.padEnd(detailWidth())}
                        </text>
                        <text fg={theme.textMuted} wrapMode="none">
                          {detail.value}
                        </text>
                      </box>
                    )}
                  </For>
                </Show>
                <text fg={theme.textMuted}>esc back · r refresh</text>
              </box>
            )}
          </Show>
        </Show>
      </Show>

      <Show when={snapshot()?.errors.length}>
        <For each={snapshot()!.errors}>{(item) => <text fg={theme.warning}>{item.message}</text>}</For>
      </Show>
    </box>
  )
}

function totalsEntry(key: string, title: string, totals: UsageSnapshot["aggregate"]): Entry {
  // A subscription session costs nothing per token, so its spend is a constant
  // zero — noise next to the figure that matters. Show money only when there is
  // some. This cannot use the model's pricing the way the footer does: the
  // snapshot has no per-session model, and the aggregate legitimately mixes
  // metered and unmetered sessions.
  const spend = totals.spend > 0 ? ` · ${money(totals.spend)}` : ""
  return {
    key,
    title,
    headline: `${compact(totals.tokens.total)} tokens${spend}`,
    details: [
      { label: "input", value: compact(totals.tokens.input) },
      { label: "output", value: compact(totals.tokens.output) },
      { label: "reasoning", value: compact(totals.tokens.reasoning) },
      { label: "cache read", value: compact(totals.tokens.cacheRead) },
      { label: "cache write", value: compact(totals.tokens.cacheWrite) },
      { label: "total", value: compact(totals.tokens.total) },
      ...(totals.spend > 0 ? [{ label: "spend", value: `$${totals.spend.toFixed(4)}` }] : []),
    ],
  }
}

/** Six-digit token counts are noise in a menu; "878k" is the same information. */
function compact(value: number) {
  if (!Number.isFinite(value)) return "0"
  if (value < 1000) return String(Math.round(value))
  if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`
  return `${(value / 1_000_000).toFixed(1)}m`
}

function money(value: number) {
  if (value <= 0) return "$0"
  return value < 0.01 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`
}

function since(iso: string, now = Date.now()) {
  const at = Date.parse(iso)
  if (!Number.isFinite(at)) return iso
  const mins = Math.round((now - at) / 60_000)
  if (mins < 1) return "just now"
  if (mins < 60) return `${mins}m ago`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}
