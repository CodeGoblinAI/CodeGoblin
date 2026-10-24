import { createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { useSync } from "@tui/context/sync"
import { DialogSelect } from "@tui/ui/dialog-select"
import { useDialog } from "@tui/ui/dialog"
import { Locale } from "@/util/locale"
import { searchHistory } from "../../util/history-search"

export function DialogHistorySearch(props: { sessionID: string; onSelect: (messageID: string) => void }) {
  const sync = useSync()
  const dialog = useDialog()
  const [query, setQuery] = createSignal("")
  const [error, setError] = createSignal(false)
  const controller = new AbortController()
  onCleanup(() => controller.abort())
  onMount(() => {
    dialog.setSize("large")
    void sync.session.loadAll(props.sessionID, controller.signal).catch(() => {
      if (!controller.signal.aborted) setError(true)
    })
  })
  const results = createMemo(() => searchHistory(sync.data.message[props.sessionID] ?? [], sync.data.part, query()))
  const loading = () => !!sync.data.message_page[props.sessionID]?.cursor && !error()

  return (
    <DialogSelect
      title={`Search chat · ${results().length} message${results().length === 1 ? "" : "s"}${loading() ? " · loading older history…" : ""}`}
      placeholder="Search prompts, replies, files, or tool output…"
      skipFilter
      onFilter={setQuery}
      footerHints={[
        {
          title: error()
            ? "Older history failed to load; reopen /search to retry"
            : "Enter jumps to the message; Esc returns to chat",
          label: "",
        },
      ]}
      options={results().map((result) => ({
        title: result.preview,
        value: result.messageID,
        category: result.role === "user" ? "You" : "Assistant",
        footer: Locale.time(result.time),
        onSelect() {
          props.onSelect(result.messageID)
          dialog.clear()
        },
      }))}
    />
  )
}
