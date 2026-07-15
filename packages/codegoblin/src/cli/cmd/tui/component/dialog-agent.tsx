import { createMemo } from "solid-js"
import { useLocal } from "@tui/context/local"
import { DialogSelect } from "@tui/ui/dialog-select"
import { useDialog } from "@tui/ui/dialog"
import { Locale } from "@/util/locale"

// Match the prompt footer: the built-in "build" agent reads as "Agent".
const displayAgentName = (name: string) => (name.toLowerCase() === "build" ? "Agent" : Locale.titlecase(name))

export function DialogAgent() {
  const local = useLocal()
  const dialog = useDialog()

  const options = createMemo(() =>
    local.agent.list().map((item) => {
      return {
        value: item.name,
        title: displayAgentName(item.name),
        description:
          item.name.toLowerCase() === "build"
            ? "Full coding mode"
            : item.name.toLowerCase() === "plan"
              ? "Read-only planning mode"
              : (item.description ?? (item.native ? "Built-in mode" : "Custom mode")),
      }
    }),
  )

  return (
    <DialogSelect
      title="Select mode"
      current={local.agent.current()?.name}
      options={options()}
      onSelect={(option) => {
        local.agent.set(option.value)
        dialog.clear()
      }}
    />
  )
}
