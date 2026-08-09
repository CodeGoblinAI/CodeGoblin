import { createMemo, Show, type Component } from "solid-js"
import { Dialog } from "@codegoblin/ui/dialog"
import { List } from "@codegoblin/ui/list"
import { useDialog } from "@codegoblin/ui/context/dialog"
import { useTheme } from "@codegoblin/ui/theme/context"
import { useLanguage } from "@/context/language"

export const DialogSelectTheme: Component = () => {
  const dialog = useDialog()
  const language = useLanguage()
  const theme = useTheme()
  const items = createMemo(() => theme.ids().map((id) => ({ id, name: theme.name(id) })))

  return (
    <Dialog title="Switch theme" description="Choose the interface theme.">
      <List
        search={{ placeholder: language.t("common.search.placeholder"), autofocus: true }}
        items={items}
        key={(item) => item.id}
        current={items().find((item) => item.id === theme.themeId())}
        filterKeys={["name"]}
        onSelect={(item) => {
          if (!item) return
          theme.setTheme(item.id)
          dialog.close()
        }}
      >
        {(item) => (
          <div class="w-full flex items-center justify-between">
            <span>{item.name}</span>
            <Show when={item.id === theme.themeId()}>
              <span class="text-text-weak">current</span>
            </Show>
          </div>
        )}
      </List>
    </Dialog>
  )
}
