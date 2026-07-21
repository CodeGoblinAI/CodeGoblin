import { For, Show, createResource, type Component } from "solid-js"
import { Dialog } from "@codegoblin/ui/dialog"
import { useSDK } from "@/context/sdk"
import type { UsageSnapshot, UsageTotals } from "@codegoblin/core/usage"

export const DialogUsage: Component = () => {
  const sdk = useSDK()
  const [snapshot, { refetch }] = createResource<UsageSnapshot>(async () => {
    const response = await fetch(`${sdk.url}/codegoblin/usage`, {
      headers: { "x-opencode-directory": encodeURIComponent(sdk.directory) },
    })
    if (!response.ok) throw new Error("Usage is unavailable")
    return (await response.json()) as UsageSnapshot
  })

  return (
    <Dialog title="Usage" description="CodeGoblin tokens, spend, balances, and supported provider quota.">
      <Show when={!snapshot.loading} fallback={<div class="p-4 text-13-regular text-text-weak">Loading usage…</div>}>
        <Show when={snapshot()} fallback={<div class="p-4 text-13-regular text-text-weak">Usage unavailable.</div>}>
          {(value) => (
            <div class="flex flex-col gap-4 p-4 text-13-regular">
              <UsageTotals label="Current session" totals={value().session} />
              <UsageTotals label="All CodeGoblin sessions" totals={value().aggregate} />
              <Show when={value().balances.length > 0}>
                <section class="flex flex-col gap-1">
                  <h3 class="font-medium">API balances</h3>
                  <For each={value().balances}>{(item) => <div class="text-text-weak">{item.label}: {item.amount} {item.unit}</div>}</For>
                </section>
              </Show>
              <section class="flex flex-col gap-1">
                <h3 class="font-medium">Provider quota</h3>
                <Show when={value().quotas.length > 0} fallback={<div class="text-text-weak">Unavailable for connected providers.</div>}>
                  <For each={value().quotas}>{(item) => <div class="text-text-weak">{item.label}: {Math.round(item.usedPercentage)}% used · {Math.round(item.remainingPercentage)}% left</div>}</For>
                </Show>
              </section>
              <Show when={value().errors.length > 0}>
                <For each={value().errors}>{(item) => <div class="text-text-weak">{item.message}</div>}</For>
              </Show>
              <button class="self-start text-text-link hover:underline" type="button" onClick={() => void refetch()}>
                Refresh
              </button>
            </div>
          )}
        </Show>
      </Show>
    </Dialog>
  )
}

function UsageTotals(props: { label: string; totals?: UsageTotals }) {
  return (
    <Show when={props.totals} fallback={<section class="text-text-weak">{props.label}: unavailable</section>}>
      {(value) => (
        <section class="flex flex-col gap-1">
          <h3 class="font-medium">{props.label}</h3>
          <div class="text-text-weak">Tokens {value().tokens.total} · input {value().tokens.input} · output {value().tokens.output}</div>
          <div class="text-text-weak">Reasoning {value().tokens.reasoning} · cache read {value().tokens.cacheRead} · cache write {value().tokens.cacheWrite}</div>
          <div class="text-text-weak">Spend ${value().spend.toFixed(4)}</div>
        </section>
      )}
    </Show>
  )
}
