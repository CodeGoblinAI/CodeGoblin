import { For, Show, createMemo, createSignal, onCleanup, onMount, type Component } from "solid-js"
import { Dialog } from "@codegoblin/ui/dialog"
import { useGlobalSDK } from "@/context/global-sdk"
import type { UsageSnapshot } from "@codegoblin/core/usage"

type Detail = { label: string; value: string }
type Entry = { key: string; title: string; headline: string; details: Detail[]; disabled?: boolean }

export const DialogUsage: Component<{ sessionID?: string; directory?: string }> = (props) => {
  const sdk = useGlobalSDK()
  const [snapshot, setSnapshot] = createSignal<UsageSnapshot>()
  const [loading, setLoading] = createSignal(true)
  const [refreshing, setRefreshing] = createSignal(false)
  const [error, setError] = createSignal<string>()
  const [openKey, setOpenKey] = createSignal<string>()
  let poll: ReturnType<typeof setTimeout> | undefined
  let disposed = false

  const load = async (mode: "cached" | "auto" | "force" | "poll") => {
    if (mode === "cached" && !snapshot()) setLoading(true)
    if (mode === "auto" || mode === "force") setRefreshing(true)
    setError(undefined)
    const query = new URLSearchParams({
      ...(props.directory ? { directory: props.directory } : {}),
      ...(props.sessionID ? { sessionID: props.sessionID } : {}),
    })
    if (mode === "auto" || mode === "force") {
      const token = snapshot()?.refreshToken
      if (token) {
        await sdk
          .fetch(`${sdk.url}/codegoblin/usage/refresh`, {
            method: "POST",
            headers: {
              "x-codegoblin-action": "usage-refresh",
              "x-codegoblin-refresh": mode,
              "x-codegoblin-refresh-token": token,
            },
          })
          .catch(() => undefined)
      }
    }
    const response = await sdk.fetch(`${sdk.url}/codegoblin/usage?${query}`).catch(() => undefined)
    const value = response?.ok
      ? ((await response.json().catch(() => undefined)) as UsageSnapshot | undefined)
      : undefined
    if (disposed) return
    if (value) setSnapshot(value)
    if (!value && !snapshot()) setError("Usage is unavailable right now.")
    setLoading(false)
    setRefreshing(Boolean(value?.refreshing))
    if (poll) clearTimeout(poll)
    if (value?.refreshing) poll = setTimeout(() => void load("poll"), 1_500)
  }

  onMount(async () => {
    await load("cached")
    void load("auto")
  })
  onCleanup(() => {
    disposed = true
    if (poll) clearTimeout(poll)
  })

  const entries = createMemo(() => (snapshot() ? usageEntries(snapshot()!) : []))
  const opened = createMemo(() => entries().find((entry) => entry.key === openKey()))

  return (
    <Dialog
      title={opened() ? `Usage · ${opened()!.title}` : "Usage"}
      description="CodeGoblin tokens, spend, balances, and supported provider quota."
    >
      <Show when={!loading()} fallback={<div class="min-w-96 p-5 text-13-regular text-text-weak">Loading usage…</div>}>
        <Show
          when={snapshot()}
          fallback={<div class="min-w-96 p-5 text-13-regular text-text-weak">{error() ?? "Usage unavailable."}</div>}
        >
          {(value) => (
            <div class="flex min-w-[32rem] max-w-[42rem] flex-col gap-4 p-4 text-13-regular">
              <div class="flex items-center justify-between gap-4 rounded-md border border-border-base bg-surface-raised-base px-3 py-2">
                <span class="text-text-weak">
                  {refreshing() ? "Refreshing provider quotas in the background…" : "Provider quotas are up to date."}
                </span>
                <button
                  class="shrink-0 rounded px-2 py-1 text-text-link hover:bg-surface-raised-base-hover disabled:opacity-50"
                  type="button"
                  disabled={refreshing()}
                  onClick={() => void load("force")}
                >
                  {refreshing() ? "Refreshing…" : "Refresh"}
                </button>
              </div>
              <Show
                when={opened()}
                fallback={
                  <div class="flex flex-col overflow-hidden rounded-md border border-border-base">
                    <For each={entries()}>
                      {(entry) => (
                        <button
                          type="button"
                          disabled={entry.disabled}
                          class="flex w-full items-center justify-between gap-6 border-b border-border-weak-base px-3 py-2.5 text-left last:border-b-0 hover:bg-surface-raised-base-hover disabled:cursor-default disabled:opacity-50"
                          onClick={() => setOpenKey(entry.key)}
                        >
                          <span class="text-text-strong">{entry.title}</span>
                          <span class="text-right text-text-weak">{entry.headline}</span>
                        </button>
                      )}
                    </For>
                  </div>
                }
              >
                {(entry) => (
                  <div class="flex flex-col gap-3">
                    <button
                      class="self-start rounded px-2 py-1 text-text-link hover:bg-surface-raised-base-hover"
                      type="button"
                      onClick={() => setOpenKey(undefined)}
                    >
                      ← Back to usage
                    </button>
                    <div class="flex flex-col overflow-hidden rounded-md border border-border-base">
                      <For each={entry().details}>
                        {(detail) => (
                          <div class="flex items-start justify-between gap-6 border-b border-border-weak-base px-3 py-2.5 last:border-b-0">
                            <span class="text-text-strong">{detail.label}</span>
                            <span class="text-right text-text-weak">{detail.value}</span>
                          </div>
                        )}
                      </For>
                    </div>
                  </div>
                )}
              </Show>
              <Show when={value().errors.length > 0}>
                <For each={value().errors}>{(item) => <div class="text-text-weak">{item.message}</div>}</For>
              </Show>
            </div>
          )}
        </Show>
      </Show>
    </Dialog>
  )
}

function usageEntries(value: UsageSnapshot): Entry[] {
  const entries = [
    ...(value.session ? [totalsEntry("session", "Current session", value.session)] : []),
    totalsEntry("aggregate", "All sessions", value.aggregate),
  ]
  const quotas = new Map<string, UsageSnapshot["quotas"]>()
  value.quotas.forEach((quota) => quotas.set(quota.providerID, [...(quotas.get(quota.providerID) ?? []), quota]))
  quotas.forEach((items, providerID) => {
    const label = value.quotaStatuses?.find((item) => item.providerID === providerID)?.label ?? providerID
    const tightest = [...items].sort((a, b) => a.remainingPercentage - b.remainingPercentage)[0]
    entries.push({
      key: `quota:${providerID}`,
      title: label,
      headline: `${tightest.window} ${Math.round(tightest.remainingPercentage)}% left`,
      details: items.map((item) => ({
        label: item.window,
        value: `${Math.round(item.remainingPercentage)}% left · ${Math.round(item.usedPercentage)}% used${
          item.resetsAt ? ` · resets in ${item.resetsAt}` : ""
        }`,
      })),
    })
  })
  value.quotaStatuses?.forEach((status) => {
    if (status.available) return
    entries.push({
      key: `unavailable:${status.providerID}`,
      title: status.label,
      headline: "unavailable",
      details: [],
      disabled: true,
    })
  })
  if (value.balances.length) {
    entries.push({
      key: "balances",
      title: "API balances",
      headline: value.balances.map((item) => `${item.amount} ${item.unit}`).join(" · "),
      details: value.balances.map((item) => ({
        label: item.label,
        value: `${item.amount} ${item.unit}${item.live ? "" : " (manual)"}`,
      })),
    })
  }
  return entries
}

function totalsEntry(key: string, title: string, totals: UsageSnapshot["aggregate"]): Entry {
  return {
    key,
    title,
    headline: `${compact(totals.tokens.total)} tokens · ${money(totals.spend)}`,
    details: [
      { label: "input", value: compact(totals.tokens.input) },
      { label: "output", value: compact(totals.tokens.output) },
      { label: "reasoning", value: compact(totals.tokens.reasoning) },
      { label: "cache read", value: compact(totals.tokens.cacheRead) },
      { label: "cache write", value: compact(totals.tokens.cacheWrite) },
      { label: "total", value: compact(totals.tokens.total) },
      { label: "spend", value: `$${totals.spend.toFixed(4)}` },
    ],
  }
}

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
