import { createMemo, Show } from "solid-js"
import { useLocal } from "@tui/context/local"
import { DialogSelect } from "@tui/ui/dialog-select"
import { DialogAlert } from "@tui/ui/dialog-alert"
import { useDialog } from "@tui/ui/dialog"
import { reasoningEffortOptions } from "@codegoblin/core/usage"

export function DialogEffort() {
  const local = useLocal()
  const dialog = useDialog()
  const options = createMemo(() => reasoningEffortOptions(local.model.variant.list()))

  return (
    <Show
      when={options().length > 0}
      fallback={
        <DialogAlert
          title="Reasoning effort unavailable"
          message="The current provider/model does not expose a supported effort setting."
        />
      }
    >
      <DialogSelect<string>
        options={[
          {
            value: "default",
            title: "Default",
            onSelect: () => {
              dialog.clear()
              local.model.variant.set(undefined)
            },
          },
          ...options().map((value) => ({
            value,
            title: value,
            onSelect: () => {
              dialog.clear()
              local.model.variant.set(value)
            },
          })),
        ]}
        title="Select effort"
        current={local.model.variant.selected()}
        flat={true}
      />
    </Show>
  )
}
