import { createMemo, createSignal } from "solid-js"
import { map } from "remeda"
import { DialogSelect, type DialogSelectRef, type DialogSelectOption } from "@tui/ui/dialog-select"
import { DialogPrompt } from "@tui/ui/dialog-prompt"
import { DialogAlert } from "@tui/ui/dialog-alert"
import { useDialog } from "@tui/ui/dialog"
import { useSDK } from "@tui/context/sdk"
import { useTheme } from "../context/theme"
import { TextAttributes } from "@opentui/core"
import type { CodeGoblinMemoryEntry } from "@/codegoblin/memory"

function Badge(props: { entry: CodeGoblinMemoryEntry }) {
  const { theme } = useTheme()
  if (props.entry.archived) return <span style={{ fg: theme.textMuted }}>archived</span>
  if (props.entry.pinned)
    return <span style={{ fg: theme.success, attributes: TextAttributes.BOLD }}>★ pinned · {props.entry.scope}</span>
  return <span style={{ fg: theme.textMuted }}>{props.entry.scope}</span>
}

export function DialogMemory() {
  const dialog = useDialog()
  const sdk = useSDK()
  const [, setRef] = createSignal<DialogSelectRef<string>>()
  const [entries, setEntries] = createSignal<CodeGoblinMemoryEntry[]>([])
  const [query, setQuery] = createSignal("")
  const [busy, setBusy] = createSignal(false)

  async function refresh() {
    const result = await sdk.client.memory.list({
      query: query() || undefined,
      includeArchived: "true",
    })
    if (result.data) setEntries(result.data as CodeGoblinMemoryEntry[])
  }

  refresh()

  const options = createMemo<DialogSelectOption<string>[]>(() => {
    const rows = map(entries(), (entry) => ({
      value: entry.id,
      title: entry.content.length > 72 ? `${entry.content.slice(0, 71)}…` : entry.content,
      description: entry.tags.length ? entry.tags.join(", ") : undefined,
      footer: <Badge entry={entry} />,
    }))
    return [{ value: "__add__", title: "+ Add a memory…", description: "Store a new project-scoped memory" }, ...rows]
  })

  const actions = createMemo(() => [
    {
      command: "dialog.memory.pin",
      title: "pin",
      onTrigger: async (option: DialogSelectOption<string>) => {
        if (busy() || option.value === "__add__") return
        const entry = entries().find((item) => item.id === option.value)
        if (!entry || entry.archived) return
        setBusy(true)
        try {
          await sdk.client.memory.pin({ id: entry.id, pinned: !entry.pinned })
          await refresh()
        } finally {
          setBusy(false)
        }
      },
    },
    {
      command: "dialog.memory.archive",
      title: "archive",
      onTrigger: async (option: DialogSelectOption<string>) => {
        if (busy() || option.value === "__add__") return
        const entry = entries().find((item) => item.id === option.value)
        if (!entry) return
        setBusy(true)
        try {
          if (entry.archived) await sdk.client.memory.restore({ id: entry.id })
          else await sdk.client.memory.remove({ id: entry.id })
          await refresh()
        } finally {
          setBusy(false)
        }
      },
    },
  ])

  return (
    <DialogSelect
      ref={setRef}
      title="CodeGoblin Memory"
      placeholder="Search memory…"
      options={options()}
      actions={actions()}
      onFilter={(value) => {
        setQuery(value)
        refresh()
      }}
      onSelect={(option) => {
        if (option.value === "__add__") {
          dialog.replace(() => <DialogMemoryAdd />)
          return
        }
        const entry = entries().find((item) => item.id === option.value)
        if (!entry) return
        const detail = [
          `Scope: ${entry.scope}`,
          entry.tags.length ? `Tags: ${entry.tags.join(", ")}` : undefined,
          entry.pinned ? "Pinned" : undefined,
          entry.archived ? "Archived" : undefined,
          "",
          entry.content,
        ]
          .filter((line) => line !== undefined)
          .join("\n")
        dialog.replace(() => <DialogAlert title="Memory entry" message={detail} />)
      }}
    />
  )
}

export function DialogMemoryAdd() {
  const dialog = useDialog()
  const sdk = useSDK()

  return (
    <DialogPrompt
      title="Add memory (project scope)"
      placeholder="What should CodeGoblin remember?"
      onConfirm={async (value) => {
        const content = value.trim()
        if (!content) {
          dialog.replace(() => <DialogMemory />)
          return
        }
        const result = await sdk.client.memory.add({ scope: "project", content })
        if (result.error) {
          const message = "error" in result.error ? String(result.error.error) : "Memory rejected by the guard."
          dialog.replace(() => <DialogAlert title="Memory rejected" message={message} />)
          return
        }
        dialog.replace(() => <DialogMemory />)
      }}
    />
  )
}
