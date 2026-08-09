import { createMemo, Show, type Component } from "solid-js"
import { Dialog } from "@codegoblin/ui/dialog"
import { List } from "@codegoblin/ui/list"
import { useDialog } from "@codegoblin/ui/context/dialog"
import { useLocal } from "@/context/local"
import { useLanguage } from "@/context/language"

export const DialogSelectMode: Component = () => {
  const local = useLocal()
  const dialog = useDialog()
  const language = useLanguage()
  const items = createMemo(() => local.agent.list().map((agent) => agent.name))

  return (
    <Dialog title="Switch mode" description="Choose the active agent or mode.">
      <Show when={items().length > 0} fallback={<div class="p-4 text-13-regular text-text-weak">No modes are available.</div>}>
        <List
          search={{ placeholder: language.t("common.search.placeholder"), autofocus: true }}
          items={items}
          key={(item) => item}
          current={local.agent.current()?.name}
          filterKeys={[]}
          onSelect={(item) => {
            if (!item) return
            local.agent.set(item)
            dialog.close()
          }}
        >
          {(item) => <div class="w-full flex items-center justify-between"><span>{item}</span><Show when={item === local.agent.current()?.name}><span class="text-text-weak">current</span></Show></div>}
        </List>
      </Show>
    </Dialog>
  )
}
