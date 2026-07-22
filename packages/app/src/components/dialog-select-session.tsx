import { createMemo, Show, type Component } from "solid-js"
import { Dialog } from "@codegoblin/ui/dialog"
import { List } from "@codegoblin/ui/list"
import { useDialog } from "@codegoblin/ui/context/dialog"
import { useLanguage } from "@/context/language"
import { useSync } from "@/context/sync"

export const DialogSelectSession: Component<{ onSelect: (sessionID: string) => void }> = (props) => {
  const sync = useSync()
  const dialog = useDialog()
  const language = useLanguage()
  const items = createMemo(() =>
    sync.data.session
      .filter((session) => !session.parentID && !session.time.archived)
      .toSorted((a, b) => b.time.updated - a.time.updated),
  )

  return (
    <Dialog title="Resume session" description="Open a previous session in this workspace.">
      <Show
        when={items().length > 0}
        fallback={<div class="p-4 text-13-regular text-text-weak">No sessions are available in this workspace.</div>}
      >
        <List
          search={{ placeholder: language.t("common.search.placeholder"), autofocus: true }}
          items={items}
          key={(item) => item.id}
          filterKeys={["title"]}
          onSelect={(item) => {
            if (!item) return
            props.onSelect(item.id)
            dialog.close()
          }}
        >
          {(item) => (
            <div class="w-full flex items-center justify-between gap-4">
              <span class="truncate">{item.title}</span>
              <span class="shrink-0 text-text-weak">{new Date(item.time.updated).toLocaleString()}</span>
            </div>
          )}
        </List>
      </Show>
    </Dialog>
  )
}
