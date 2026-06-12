import { Button } from "@codegoblin/ui/button"
import { TextField } from "@codegoblin/ui/text-field"
import { For, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { Link } from "@/components/link"

type MarketEnvField = { name: string; label?: string; description: string; link?: string }

export type MarketConfigureEntry = {
  id: string
  name: string
  env?: MarketEnvField[]
}

function envLabel(field: MarketEnvField) {
  if (field.label) return field.label
  return field.name
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ")
}

export function MarketConfigureForm(props: {
  entry: MarketConfigureEntry
  pending?: boolean
  submitLabel?: string
  onBack: () => void
  onInstall: (env: Record<string, string>) => void
}) {
  const [store, setStore] = createStore({
    values: {} as Record<string, string>,
    error: undefined as string | undefined,
  })

  function handleSubmit(e: SubmitEvent) {
    e.preventDefault()
    for (const field of props.entry.env ?? []) {
      if (!store.values[field.name]?.trim()) {
        setStore("error", `${envLabel(field)} is required.`)
        return
      }
    }
    setStore("error", undefined)
    props.onInstall(
      Object.fromEntries((props.entry.env ?? []).map((field) => [field.name, store.values[field.name]!.trim()])),
    )
  }

  return (
    <form onSubmit={handleSubmit} class="flex flex-col gap-6 px-5 pb-5">
      <Button type="button" variant="ghost" size="small" class="self-start px-0" disabled={props.pending} onClick={() => props.onBack()}>
        ← Back to Market
      </Button>

      <For each={props.entry.env ?? []}>
        {(field, index) => (
          <div class="flex flex-col gap-3">
            <TextField
              autofocus={index() === 0}
              type="password"
              label={envLabel(field)}
              description={field.description}
              value={store.values[field.name] ?? ""}
              onChange={(value) => setStore("values", field.name, value)}
              validationState={store.error ? "invalid" : undefined}
              error={store.error}
            />
            <Show when={field.link}>
              <Link href={field.link!} tabIndex={-1} class="text-14-regular text-text-weaker w-fit -mt-1">
                Open integration settings →
              </Link>
            </Show>
          </div>
        )}
      </For>

      <div class="flex justify-end gap-2">
        <Button type="button" variant="ghost" disabled={props.pending} onClick={() => props.onBack()}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" disabled={props.pending}>
          {props.submitLabel ?? "Install"}
        </Button>
      </div>
    </form>
  )
}
