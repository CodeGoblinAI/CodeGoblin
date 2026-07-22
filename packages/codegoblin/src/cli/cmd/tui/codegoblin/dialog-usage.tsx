import { For, Show, createSignal, onMount } from "solid-js"
import type { UsageSnapshot } from "@codegoblin/core/usage"
import { useRoute } from "@tui/context/route"
import { useSDK } from "@tui/context/sdk"
import { useDialog } from "@tui/ui/dialog"
import { useTheme } from "@tui/context/theme"
import { useBindings } from "@tui/keymap"
import { TextAttributes } from "@opentui/core"

export function DialogUsage() {
  const sdk = useSDK()
  const route = useRoute()
  const dialog = useDialog()
  const { theme } = useTheme()
  const [snapshot, setSnapshot] = createSignal<UsageSnapshot>()
  const [loading, setLoading] = createSignal(true)
  const [error, setError] = createSignal<string>()

  const refresh = async (active = false) => {
    setLoading(true)
    setError(undefined)
    const sessionID = route.data.type === "session" ? route.data.sessionID : undefined
    const query = new URLSearchParams({
      ...(sessionID ? { sessionID } : {}),
      ...(active ? { refresh: "1" } : {}),
    })
    const response = await sdk
      .fetch(`${sdk.url}/codegoblin/usage?${query}`)
      .catch(() => undefined)
    if (!response?.ok) {
      setError("Usage is unavailable right now.")
      setLoading(false)
      return
    }
    const value = (await response.json().catch(() => undefined)) as UsageSnapshot | undefined
    if (!value) setError("Usage returned an invalid response.")
    else setSnapshot(value)
    setLoading(false)
  }

  onMount(() => void refresh())
  useBindings(() => ({
    bindings: [
      {
        key: "r",
        desc: "Refresh usage",
        group: "Dialog",
        cmd: () => void refresh(true),
      },
    ],
  }))

  return (
    <box paddingLeft={2} paddingRight={2} gap={1} paddingBottom={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text fg={theme.text} attributes={TextAttributes.BOLD}>
          Usage
        </text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
          esc
        </text>
      </box>
      <Show when={!loading()} fallback={<text fg={theme.textMuted}>Loading usage…</text>}>
        <Show when={snapshot()} fallback={<text fg={theme.error}>{error() ?? "Usage unavailable."}</text>}>
          {(value) => (
            <box gap={1}>
              <UsageTotals label="Current session" totals={value().session} theme={theme} />
              <UsageTotals label="All CodeGoblin sessions" totals={value().aggregate} theme={theme} />
              <Show when={value().balances.length > 0}>
                <box>
                  <text fg={theme.text}>API balances</text>
                  <For each={value().balances}>
                    {(balance) => <text fg={theme.textMuted}>{`${balance.label}: ${balance.amount} ${balance.unit}`}</text>}
                  </For>
                </box>
              </Show>
              <Show when={value().quotas.length > 0}>
                <box>
                  <text fg={theme.text}>Provider subscription windows</text>
                  <For each={value().quotas}>
                    {(quota) => (
                      <text fg={theme.textMuted}>
                        {`${quota.label}: ${Math.round(quota.usedPercentage)}% used · ${Math.round(quota.remainingPercentage)}% left`}
                      </text>
                    )}
                  </For>
                </box>
              </Show>
              <Show when={value().quotas.length === 0}>
                <text fg={theme.textMuted}>Provider quota: unavailable</text>
              </Show>
              <Show when={value().errors.length > 0}>
                <For each={value().errors}>{(item) => <text fg={theme.warning}>{item.message}</text>}</For>
              </Show>
              <text fg={theme.textMuted}>Press r to refresh</text>
            </box>
          )}
        </Show>
      </Show>
    </box>
  )
}

function UsageTotals(props: { label: string; totals?: UsageSnapshot["aggregate"]; theme: ReturnType<typeof useTheme>["theme"] }) {
  return (
    <Show when={props.totals} fallback={<text fg={props.theme.textMuted}>{props.label}: unavailable</text>}>
      {(value) => (
        <box>
          <text fg={props.theme.text}>{props.label}</text>
          <text fg={props.theme.textMuted}>{`Tokens ${value().tokens.total} · input ${value().tokens.input} · output ${value().tokens.output}`}</text>
          <text fg={props.theme.textMuted}>{`Cache read ${value().tokens.cacheRead} · write ${value().tokens.cacheWrite} · reasoning ${value().tokens.reasoning}`}</text>
          <text fg={props.theme.textMuted}>{`Spend $${value().spend.toFixed(4)}`}</text>
        </box>
      )}
    </Show>
  )
}
